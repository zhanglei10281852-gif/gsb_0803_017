import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/server/ledger';
import {
  sealSnapshot,
  loadSnapshotView,
  compareSnapshots,
  verifySnapshotDigest,
  computeDigest,
  reproduceSnapshotView,
} from '../../src/server/snapshots';
import { buildScript } from '../../src/sample/script';
import type { SpanEventInput, ReplayCursor } from '../../src/shared/contract';
import { CONTRACT_VERSION } from '../../src/shared/contract';

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
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

function seed(ledger: Ledger, seedNum = 1): void {
  ledger.appendBatch(buildScript(seedNum).map((s) => s.event), Date.now());
}

const lateEvent = (eventTimeMs: number): SpanEventInput => ({
  contractVersion: CONTRACT_VERSION,
  traceId: 'trace-late',
  spanId: 'late-span',
  parentSpanId: null,
  service: 'late-svc',
  operation: 'lateOp',
  revision: 0,
  eventTimeMs,
  durationMs: 5,
  status: 'error',
  revisionReason: null,
  errorKind: 'ArrivedLate',
});

describe('sealSnapshot: provenance + reproducibility', () => {
  it('records ledger high-water and a stable digest', () => {
    const ledger = new Ledger(tmpDb());
    seed(ledger);
    const bounds = ledger.bounds();
    const cursor: ReplayCursor = { eventTimeMs: bounds.maxEventTimeMs, ingestSequence: bounds.maxIngestSequence };
    const sealed = sealSnapshot(ledger, { label: 'A', note: 'root cause?', cursor }, 111);

    expect(sealed.snapshot.provenance.ledgerHighWater).toBe(bounds.maxIngestSequence);
    expect(sealed.snapshot.provenance.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.snapshot.note).toBe('root cause?');

    // Re-deriving the digest from the frozen slice matches exactly.
    const view = reproduceSnapshotView(ledger, sealed.snapshot.cursor, sealed.snapshot.provenance.ledgerHighWater);
    const recomputed = computeDigest({
      label: 'A',
      note: 'root cause?',
      cursor: sealed.snapshot.cursor,
      ledgerHighWater: sealed.snapshot.provenance.ledgerHighWater,
      view,
    });
    expect(recomputed).toBe(sealed.snapshot.provenance.digest);
    ledger.close();
  });
});

describe('immutability against late events', () => {
  it('a late event produces a NEW snapshot but never rewrites a sealed one', () => {
    const ledger = new Ledger(tmpDb());
    seed(ledger);
    const bounds = ledger.bounds();
    const cursor: ReplayCursor = { eventTimeMs: bounds.maxEventTimeMs, ingestSequence: bounds.maxIngestSequence };
    const a = sealSnapshot(ledger, { label: 'A', note: null, cursor }, 1);

    // A late, out-of-timeline event arrives AFTER sealing.
    ledger.append(lateEvent(bounds.maxEventTimeMs + 5), Date.now());

    // The already-sealed snapshot still verifies to its original digest.
    expect(verifySnapshotDigest(ledger, a.snapshot.id)).toBe(true);
    const reloaded = loadSnapshotView(ledger, a.snapshot.id)!;
    expect(reloaded.snapshot.provenance.digest).toBe(a.snapshot.provenance.digest);
    // And the late span is NOT visible in the frozen view.
    expect(reloaded.view.spans.find((s) => s.spanId === 'late-span')).toBeUndefined();

    // A new snapshot sealed now captures the higher high-water and the late span.
    const newBounds = ledger.bounds();
    const b = sealSnapshot(
      ledger,
      { label: 'B', note: null, cursor: { eventTimeMs: newBounds.maxEventTimeMs, ingestSequence: newBounds.maxIngestSequence } },
      2,
    );
    expect(b.snapshot.provenance.ledgerHighWater).toBeGreaterThan(a.snapshot.provenance.ledgerHighWater);
    expect(b.view.spans.find((s) => s.spanId === 'late-span')).toBeDefined();
    expect(b.snapshot.provenance.digest).not.toBe(a.snapshot.provenance.digest);
    ledger.close();
  });
});

describe('restart stability', () => {
  it('reproduces the identical digest after reopening the SQLite store', () => {
    const path = tmpDb();
    const ledger = new Ledger(path);
    seed(ledger);
    const bounds = ledger.bounds();
    const a = sealSnapshot(
      ledger,
      { label: 'A', note: 'note that survives restart', cursor: { eventTimeMs: bounds.maxEventTimeMs, ingestSequence: bounds.maxIngestSequence } },
      42,
    );
    const digestBefore = a.snapshot.provenance.digest;
    ledger.close();

    // Reopen (simulated restart): no re-ingest.
    const reopened = new Ledger(path);
    const reloaded = loadSnapshotView(reopened, a.snapshot.id)!;
    expect(reloaded.snapshot.provenance.digest).toBe(digestBefore);
    expect(verifySnapshotDigest(reopened, a.snapshot.id)).toBe(true);
    // The reproduced view is byte-identical too.
    expect(JSON.stringify(reloaded.view.spans)).toEqual(JSON.stringify(a.view.spans));
    reopened.close();
  });
});

describe('compareSnapshots: A -> B diff', () => {
  it('surfaces the correction between a pre- and post-correction snapshot', () => {
    const ledger = new Ledger(tmpDb());
    const accepted = ledger.appendBatch(buildScript(1).map((s) => s.event), Date.now()).accepted;
    const bounds = ledger.bounds();

    // Find the ingest sequence at which payments r1 (the correction) arrived.
    const paymentsR1 = accepted.find((r) => r.spanId === 'payments' && r.revision === 1)!;
    const beforeSeq = paymentsR1.ingestSequence - 1;

    const a = sealSnapshot(
      ledger,
      { label: 'A', note: 'before correction', cursor: { eventTimeMs: bounds.maxEventTimeMs, ingestSequence: beforeSeq } },
      1,
    );
    const b = sealSnapshot(
      ledger,
      { label: 'B', note: 'after correction', cursor: { eventTimeMs: bounds.maxEventTimeMs, ingestSequence: bounds.maxIngestSequence } },
      2,
    );

    const cmp = compareSnapshots(ledger, a.snapshot.id, b.snapshot.id)!;
    const payments = cmp.changed.find((d) => d.spanId === 'payments');
    if (payments) {
      // payments flips ok -> error and r0 -> r1 across the correction.
      expect(payments.statusChanged || payments.revisionChanged).toBe(true);
    } else {
      // If payments only becomes visible in B, it shows as added instead.
      expect(cmp.added.find((d) => d.spanId === 'payments')).toBeDefined();
    }
    // Comparison is deterministic.
    const cmp2 = compareSnapshots(ledger, a.snapshot.id, b.snapshot.id)!;
    expect(JSON.stringify(cmp)).toEqual(JSON.stringify(cmp2));
    ledger.close();
  });
});
