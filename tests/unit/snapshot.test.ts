import { describe, it, expect } from 'vitest';
import { canonicalSnapshotContent, diffSnapshotViews } from '../../src/shared/snapshot';
import { projectView } from '../../src/shared/projection';
import type { IncidentSnapshot, LedgerRecord, ProjectionView, ReplayCursor } from '../../src/shared/contract';
import { CONTRACT_VERSION } from '../../src/shared/contract';

function rec(p: Partial<LedgerRecord> & Pick<LedgerRecord, 'spanId' | 'ingestSequence'>): LedgerRecord {
  return {
    contractVersion: CONTRACT_VERSION,
    traceId: p.traceId ?? 'T',
    spanId: p.spanId,
    parentSpanId: p.parentSpanId ?? null,
    service: p.service ?? 'svc',
    operation: p.operation ?? 'op',
    revision: p.revision ?? 0,
    eventTimeMs: p.eventTimeMs ?? 1000,
    durationMs: p.durationMs ?? 10,
    status: p.status ?? 'ok',
    revisionReason: p.revisionReason ?? null,
    errorKind: p.errorKind ?? null,
    ingestSequence: p.ingestSequence,
    receivedAtMs: p.receivedAtMs ?? 0,
  };
}

function snap(id: number, cursor: ReplayCursor, highWater: number): IncidentSnapshot {
  return {
    contractVersion: CONTRACT_VERSION,
    id,
    label: id === 1 ? 'A' : 'B',
    note: null,
    cursor,
    provenance: { ledgerHighWater: highWater, digestAlgorithm: 'sha256', digest: 'x' },
    sealedAtMs: 0,
  };
}

describe('canonicalSnapshotContent determinism', () => {
  const records: LedgerRecord[] = [
    rec({ spanId: 'a', parentSpanId: null, ingestSequence: 1, eventTimeMs: 100 }),
    rec({ spanId: 'b', parentSpanId: 'a', ingestSequence: 2, eventTimeMs: 200, status: 'error' }),
  ];
  const cursor: ReplayCursor = { eventTimeMs: 200, ingestSequence: 2 };

  it('is independent of record input order', () => {
    const forward = projectView(records, cursor);
    const backward = projectView([records[1]!, records[0]!], cursor);
    const c1 = canonicalSnapshotContent({ label: 'A', note: 'n', cursor, ledgerHighWater: 2, view: forward });
    const c2 = canonicalSnapshotContent({ label: 'A', note: 'n', cursor, ledgerHighWater: 2, view: backward });
    expect(c1).toEqual(c2);
  });

  it('changes when the note or label changes', () => {
    const view = projectView(records, cursor);
    const base = canonicalSnapshotContent({ label: 'A', note: 'n', cursor, ledgerHighWater: 2, view });
    const diffNote = canonicalSnapshotContent({ label: 'A', note: 'other', cursor, ledgerHighWater: 2, view });
    const diffLabel = canonicalSnapshotContent({ label: 'B', note: 'n', cursor, ledgerHighWater: 2, view });
    expect(diffNote).not.toEqual(base);
    expect(diffLabel).not.toEqual(base);
  });
});

describe('diffSnapshotViews categories', () => {
  const base: LedgerRecord[] = [
    rec({ spanId: 'root', parentSpanId: null, ingestSequence: 1, eventTimeMs: 100 }),
    rec({ spanId: 'child', parentSpanId: 'root', ingestSequence: 2, eventTimeMs: 200 }),
    // Correction: child becomes error at ingest 3.
    rec({ spanId: 'child', parentSpanId: 'root', revision: 1, ingestSequence: 3, eventTimeMs: 200, status: 'error', errorKind: 'boom' }),
    // A later, independent span appears at ingest 4 / eventTime 300.
    rec({ spanId: 'late', parentSpanId: 'root', ingestSequence: 4, eventTimeMs: 300 }),
  ];

  const viewAtCursor = (cursor: ReplayCursor): ProjectionView => projectView(base, cursor);

  it('detects added spans between A and B', () => {
    const a = viewAtCursor({ eventTimeMs: 200, ingestSequence: 2 });
    const b = viewAtCursor({ eventTimeMs: 300, ingestSequence: 4 });
    const cmp = diffSnapshotViews(snap(1, a.cursor, 2), a, snap(2, b.cursor, 4), b);
    expect(cmp.added.map((d) => d.spanId)).toContain('late');
    expect(cmp.summary.added).toBeGreaterThanOrEqual(1);
  });

  it('detects status + revision + path change when the correction arrives', () => {
    // A: before the correction (ingest 2) — child is ok.
    const a = viewAtCursor({ eventTimeMs: 200, ingestSequence: 2 });
    // B: after the correction (ingest 3) — child is error, root now on error path.
    const b = viewAtCursor({ eventTimeMs: 200, ingestSequence: 3 });
    const cmp = diffSnapshotViews(snap(1, a.cursor, 2), a, snap(2, b.cursor, 3), b);

    const childDelta = cmp.changed.find((d) => d.spanId === 'child')!;
    expect(childDelta.statusChanged).toBe(true);
    expect(childDelta.revisionChanged).toBe(true);
    expect(childDelta.before?.status).toBe('ok');
    expect(childDelta.after?.status).toBe('error');

    // root moves onto the error path (path change) without a status change.
    const rootDelta = cmp.changed.find((d) => d.spanId === 'root')!;
    expect(rootDelta.pathChanged).toBe(true);
    expect(cmp.summary.pathChanged).toBeGreaterThanOrEqual(1);
  });

  it('detects removed spans when B is earlier than A', () => {
    const a = viewAtCursor({ eventTimeMs: 300, ingestSequence: 4 });
    const b = viewAtCursor({ eventTimeMs: 200, ingestSequence: 2 });
    const cmp = diffSnapshotViews(snap(1, a.cursor, 4), a, snap(2, b.cursor, 2), b);
    expect(cmp.removed.map((d) => d.spanId)).toContain('late');
  });

  it('is deterministic and order-stable', () => {
    const a = viewAtCursor({ eventTimeMs: 200, ingestSequence: 2 });
    const b = viewAtCursor({ eventTimeMs: 300, ingestSequence: 4 });
    const c1 = diffSnapshotViews(snap(1, a.cursor, 2), a, snap(2, b.cursor, 4), b);
    const c2 = diffSnapshotViews(snap(1, a.cursor, 2), a, snap(2, b.cursor, 4), b);
    expect(JSON.stringify(c1)).toEqual(JSON.stringify(c2));
  });
});
