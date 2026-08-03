import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpanEvent } from '../../src/shared/contracts';
import { LedgerStore } from '../../src/server/ledgerStore';
import { ReplayService } from '../../src/server/replayService';
import { InvestigationService } from '../../src/server/investigationService';

function event(spanId: string, revision: number, eventTime: number): SpanEvent {
  return {
    contractVersion: 1,
    traceId: 't1',
    spanId,
    parentSpanId: null,
    service: spanId === 'gw' ? 'gateway' : 'payment',
    operation: 'op',
    kind: 'server',
    status: revision > 1 ? 'error' : 'ok',
    startTime: eventTime,
    endTime: eventTime + 10,
    revision,
    eventTime,
    attributes: {}
  };
}

describe('InvestigationService lease fencing', () => {
  let dir: string;
  let ledger: LedgerStore;
  let replay: ReplayService;
  let service: InvestigationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inv-'));
    ledger = new LedgerStore(join(dir, 'r.db'));
    replay = new ReplayService(ledger);
    replay.ingest([event('gw', 1, 100), event('pay', 1, 200)]);
    const anchor = replay.createSnapshot({
      labelA: 'A',
      labelB: 'B',
      cursorA: { ingestSequence: 1, eventTime: 100 },
      cursorB: { ingestSequence: 2, eventTime: 200 },
      notes: ''
    });
    service = new InvestigationService(ledger, replay, 15_000);
    service.createSession({ anchorSnapshotId: anchor.id, participantId: 'p1', participantName: 'Alice' }, 1000);
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a second client while lease is active', () => {
    const sessionId = replay.listSnapshots()[0]!.id;
    const first = service.acquireLease(sessionId, 'p1', 'Alice', 1, 1000);
    expect(first.ok).toBe(true);
    const second = service.acquireLease(sessionId, 'p2', 'Bob', 0, 1000);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('rejected-active-lease');
  });

  it('allows takeover after lease expires and bumps fencing token', () => {
    const sessionId = replay.listSnapshots()[0]!.id;
    service.acquireLease(sessionId, 'p1', 'Alice', 1, 1000);
    const takeover = service.acquireLease(sessionId, 'p2', 'Bob', 0, 20_000);
    expect(takeover.ok).toBe(true);
    expect(takeover.lease!.token).toBe(2);
    expect(takeover.lease!.leaderId).toBe('p2');
  });

  it('rejects stale old leader writes after takeover even with old token', () => {
    const sessionId = replay.listSnapshots()[0]!.id;
    service.acquireLease(sessionId, 'p1', 'Alice', 1, 1000);
    service.acquireLease(sessionId, 'p2', 'Bob', 0, 20_000);
    expect(() =>
      service.advanceSharedCursor(
        sessionId,
        'p1',
        1,
        { ingestSequence: 9, eventTime: 900 },
        'stale write',
        null,
        21_000
      )
    ).toThrow(/stale-fencing-token|not-leader|lease-expired/);
  });

  it('persists lease across a service restart (new InvestigationService same DB)', () => {
    const sessionId = replay.listSnapshots()[0]!.id;
    service.acquireLease(sessionId, 'p1', 'Alice', 1, 1000);
    const reopened = new InvestigationService(ledger, replay, 15_000);
    const session = reopened.getSession(sessionId)!;
    expect(session.lease).not.toBeNull();
    expect(session.lease!.leaderId).toBe('p1');
    expect(session.lease!.token).toBe(1);
  });
});

describe('InvestigationService notes merge', () => {
  let dir: string;
  let ledger: LedgerStore;
  let replay: ReplayService;
  let service: InvestigationService;
  let sessionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notes-'));
    ledger = new LedgerStore(join(dir, 'r.db'));
    replay = new ReplayService(ledger);
    replay.ingest([event('gw', 1, 100)]);
    const anchor = replay.createSnapshot({
      labelA: 'A',
      labelB: 'B',
      cursorA: { ingestSequence: 1, eventTime: 100 },
      cursorB: { ingestSequence: 1, eventTime: 100 },
      notes: ''
    });
    service = new InvestigationService(ledger, replay);
    const session = service.createSession(
      { anchorSnapshotId: anchor.id, participantId: 'p1', participantName: 'Alice' },
      1000
    );
    sessionId = session.id;
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends notes with monotonic seq and deterministic order', () => {
    service.addNote(
      { sessionId, participantId: 'p2', participantName: 'Bob', text: 'second', clientNoteId: 'c2' },
      2000
    );
    service.addNote(
      { sessionId, participantId: 'p1', participantName: 'Alice', text: 'first', clientNoteId: 'c1' },
      1500
    );
    const merged = service.mergeNotes(sessionId);
    expect(merged.map((n) => n.text)).toEqual(['second', 'first']);
    expect(merged[0]!.seq).toBe(1);
    expect(merged[1]!.seq).toBe(2);
  });

  it('dedupes identical clientNoteId retries instead of duplicating', () => {
    service.addNote(
      { sessionId, participantId: 'p1', participantName: 'Alice', text: 'hello', clientNoteId: 'dup' },
      1000
    );
    const second = service.addNote(
      { sessionId, participantId: 'p1', participantName: 'Alice', text: 'hello', clientNoteId: 'dup' },
      1001
    );
    expect(second.deduped).toBe(true);
    expect(service.mergeNotes(sessionId)).toHaveLength(1);
  });
});
