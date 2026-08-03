import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/server/ledger';
import { sealSnapshot } from '../../src/server/snapshots';
import {
  createSession,
  getSessionState,
  acquireLease,
  renewLease,
  releaseLease,
  advanceSharedCursor,
  addNote,
  checkWriter,
  SessionError,
} from '../../src/server/collaboration';
import { buildScript } from '../../src/sample/script';
import type { InvestigationNote } from '../../src/shared/contract';

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'collab-'));
  dirs.push(dir);
  return join(dir, 'ledger.sqlite');
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function seedAndAnchor(ledger: Ledger) {
  ledger.appendBatch(buildScript(1).map((s) => s.event), Date.now());
  const b = ledger.bounds();
  const snap = sealSnapshot(
    ledger,
    { label: 'A', note: 'handoff', cursor: { eventTimeMs: b.maxEventTimeMs, ingestSequence: b.maxIngestSequence } },
    1000,
  );
  return snap.snapshot;
}

const note = (id: string, author: string, lamport: number, body: string): InvestigationNote => ({
  id,
  author,
  lamport,
  body,
  createdAtMs: 0,
});

describe('session creation anchored to a sealed snapshot', () => {
  it('verifies the anchor digest matches the sealed snapshot', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    const s = createSession(
      ledger,
      { label: 'nightshift', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest },
      1,
    );
    expect(s.session.anchorSnapshotId).toBe(anchor.id);
    expect(s.sharedCursor).toEqual(anchor.cursor);
    ledger.close();
  });

  it('rejects a mismatched anchor digest', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    expect(() =>
      createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: 'deadbeef' }, 1),
    ).toThrow(SessionError);
    ledger.close();
  });
});

describe('lease acquire / takeover / fencing token monotonicity', () => {
  it('mints a strictly higher fencing token on every grant/takeover', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);

    // Team A acquires at t=1000, ttl 100 -> token 1.
    const a1 = acquireLease(ledger, s.session.id, 'teamA', 100, 1000);
    expect(a1.lease?.holder).toBe('teamA');
    expect(a1.lease?.fencingToken).toBe(1);

    // Team B cannot take over while A's lease is active.
    expect(() => acquireLease(ledger, s.session.id, 'teamB', 100, 1050)).toThrow(SessionError);

    // After A's lease expires (t=1200 > 1100), B takes over -> token 2.
    const b1 = acquireLease(ledger, s.session.id, 'teamB', 100, 1200);
    expect(b1.lease?.holder).toBe('teamB');
    expect(b1.lease?.fencingToken).toBe(2);
    expect(b1.highestFencingToken).toBe(2);
    ledger.close();
  });
});

describe('fencing: a stale old client cannot overwrite the new owner', () => {
  it('rejects a late writer holding an expired/superseded token', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);

    const a = acquireLease(ledger, s.session.id, 'teamA', 100, 1000); // token 1
    const tokenA = a.lease!.fencingToken;

    // A's lease expires; B takes over (token 2).
    const b = acquireLease(ledger, s.session.id, 'teamB', 100, 1200); // token 2
    const tokenB = b.lease!.fencingToken;
    expect(tokenB).toBeGreaterThan(tokenA);

    // A arrives LATE (t=1250) trying to advance the shared cursor with token 1.
    const late = advanceSharedCursor(ledger, s.session.id, 'teamA', tokenA, { eventTimeMs: 1, ingestSequence: 1 }, 1250);
    expect(late.guard.ok).toBe(false);
    if (!late.guard.ok) expect(['stale-token', 'not-holder', 'expired']).toContain(late.guard.reason);

    // B (the new owner) can advance.
    const ok = advanceSharedCursor(ledger, s.session.id, 'teamB', tokenB, { eventTimeMs: 2, ingestSequence: 2 }, 1250);
    expect(ok.guard.ok).toBe(true);
    expect(ok.state?.sharedCursor).toEqual({ eventTimeMs: 2, ingestSequence: 2 });
    expect(ok.state?.sharedCursorToken).toBe(tokenB);
    ledger.close();
  });

  it('renew fails for a holder whose token was superseded', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);
    acquireLease(ledger, s.session.id, 'teamA', 100, 1000);
    acquireLease(ledger, s.session.id, 'teamB', 100, 1200); // A superseded
    expect(() => renewLease(ledger, s.session.id, 'teamA', 1, 100, 1250)).toThrow(SessionError);
    ledger.close();
  });
});

describe('notes merge deterministically and are not lease-gated', () => {
  it('accepts concurrent notes from any participant and orders them deterministically', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);
    // No lease held; notes still accepted.
    addNote(ledger, s.session.id, note('n-b', 'teamB', 2, 'B thinks payments'), 10);
    addNote(ledger, s.session.id, note('n-a', 'teamA', 1, 'A thinks bank'), 11);
    const after = addNote(ledger, s.session.id, note('n-c', 'teamA', 2, 'A adds detail'), 12);
    // Deterministic order: lamport asc, then author, then id.
    expect(after.notes.map((n) => n.id)).toEqual(['n-a', 'n-c', 'n-b']);
    ledger.close();
  });

  it('idempotent note re-send does not duplicate', () => {
    const ledger = new Ledger(tmpDb());
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);
    addNote(ledger, s.session.id, note('dup', 'teamA', 1, 'once'), 1);
    const again = addNote(ledger, s.session.id, note('dup', 'teamA', 1, 'once'), 2);
    expect(again.notes.filter((n) => n.id === 'dup')).toHaveLength(1);
    ledger.close();
  });
});

describe('persistence across restart (lease + token + shared cursor + notes)', () => {
  it('recovers full session state after reopening the SQLite store', () => {
    const path = tmpDb();
    const ledger = new Ledger(path);
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);
    const held = acquireLease(ledger, s.session.id, 'teamA', 60_000, 5000);
    const token = held.lease!.fencingToken;
    advanceSharedCursor(ledger, s.session.id, 'teamA', token, { eventTimeMs: 7, ingestSequence: 3 }, 5001);
    addNote(ledger, s.session.id, note('n1', 'teamA', 1, 'persist me'), 5002);
    ledger.close();

    // Reopen: simulates a server restart. Lease is still valid at t=5003.
    const reopened = new Ledger(path);
    const state = getSessionState(reopened, s.session.id, 5003)!;
    expect(state.lease?.holder).toBe('teamA');
    expect(state.lease?.fencingToken).toBe(token);
    expect(state.highestFencingToken).toBe(token);
    expect(state.sharedCursor).toEqual({ eventTimeMs: 7, ingestSequence: 3 });
    expect(state.sharedCursorToken).toBe(token);
    expect(state.notes.map((n) => n.id)).toEqual(['n1']);

    // The fencing check still recognises the recovered holder after restart.
    const guard = checkWriter(reopened, s.session.id, 'teamA', token, 5003);
    expect(guard.ok).toBe(true);
    reopened.close();
  });

  it('highest fencing token never decreases after release + restart', () => {
    const path = tmpDb();
    const ledger = new Ledger(path);
    const anchor = seedAndAnchor(ledger);
    const s = createSession(ledger, { label: 'x', anchorSnapshotId: anchor.id, anchorDigest: anchor.provenance.digest }, 1);
    const held = acquireLease(ledger, s.session.id, 'teamA', 100, 1000);
    releaseLease(ledger, s.session.id, 'teamA', held.lease!.fencingToken, 1050);
    ledger.close();

    const reopened = new Ledger(path);
    // A brand-new acquire must mint token 2 (strictly above the released token 1).
    const next = acquireLease(reopened, s.session.id, 'teamB', 100, 2000);
    expect(next.lease?.fencingToken).toBe(2);
    expect(next.highestFencingToken).toBe(2);
    reopened.close();
  });
});
