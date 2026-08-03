import { describe, expect, it } from 'vitest';
import { LedgerRecord, SpanEvent } from '../../src/shared/contracts';
import { ReplayEngine } from '../../src/server/replayEngine';
import { computeDigest, diffCursors } from '../../src/server/snapshotEngine';

function event(input: {
  spanId: string;
  parentSpanId?: string | null;
  service?: string;
  operation?: string;
  revision: number;
  status?: 'ok' | 'error' | 'unset';
  eventTime: number;
  startTime?: number;
  endTime?: number;
  errorMessage?: string;
}): SpanEvent {
  return {
    contractVersion: 1,
    traceId: 'trace-1',
    spanId: input.spanId,
    parentSpanId: input.parentSpanId ?? null,
    service: input.service ?? 'gateway',
    operation: input.operation ?? 'op',
    kind: 'server',
    status: input.status ?? 'ok',
    startTime: input.startTime ?? input.eventTime,
    endTime: input.endTime ?? input.eventTime + 10,
    revision: input.revision,
    eventTime: input.eventTime,
    errorMessage: input.errorMessage,
    attributes: {}
  };
}

function asRecord(e: SpanEvent, seq: number): LedgerRecord {
  return {
    ingestSequence: seq,
    traceId: e.traceId,
    spanId: e.spanId,
    parentSpanId: e.parentSpanId,
    service: e.service,
    operation: e.operation,
    kind: e.kind,
    status: e.status,
    startTime: e.startTime,
    endTime: e.endTime,
    revision: e.revision,
    eventTime: e.eventTime,
    errorMessage: e.errorMessage ?? null,
    attributes: e.attributes ?? {},
    receivedAt: seq
  };
}

describe('snapshot digest determinism', () => {
  it('produces identical digest for same ledger and cursor after reload', () => {
    const events: SpanEvent[] = [
      event({ spanId: 'a', revision: 1, eventTime: 100 }),
      event({ spanId: 'b', parentSpanId: 'a', revision: 1, eventTime: 200, service: 'payment' })
    ];
    const records = events.map((e, i) => asRecord(e, i + 1));
    const engine1 = new ReplayEngine(records);
    const cursor = { ingestSequence: 2, eventTime: 1000 };

    const digest1 = computeDigest(engine1, cursor, records);

    const reloaded = new ReplayEngine(records.map((r) => ({ ...r })));
    const digest2 = computeDigest(reloaded, cursor, records.map((r) => ({ ...r })));

    expect(digest2.recordsDigest).toBe(digest1.recordsDigest);
    expect(digest2.viewFingerprint).toBe(digest1.viewFingerprint);
    expect(digest2.visibleRecordCount).toBe(2);
  });

  it('digest changes when a higher revision arrives', () => {
    const r1 = asRecord(event({ spanId: 'a', revision: 1, eventTime: 100, status: 'ok' }), 1);
    const engineBefore = new ReplayEngine([r1]);
    const before = computeDigest(engineBefore, { ingestSequence: 1, eventTime: 1000 }, [r1]);

    const r2 = asRecord(
      event({ spanId: 'a', revision: 2, eventTime: 150, status: 'error', errorMessage: 'boom' }),
      2
    );
    const engineAfter = new ReplayEngine([r1, r2]);
    const after = computeDigest(engineAfter, { ingestSequence: 2, eventTime: 1000 }, [r1, r2]);

    expect(after.recordsDigest).not.toBe(before.recordsDigest);
    expect(after.viewFingerprint).not.toBe(before.viewFingerprint);
    expect(after.ledgerHighWatermark.maxIngestSequence).toBe(2);
  });
});

describe('snapshot A/B diff', () => {
  it('reports added, status-changed, revision-changed and critical path change', () => {
    const base: LedgerRecord[] = [
      asRecord(event({ spanId: 'gw', revision: 1, eventTime: 100, status: 'ok' }), 1),
      asRecord(
        event({ spanId: 'pay', parentSpanId: 'gw', service: 'payment', revision: 1, eventTime: 200, status: 'ok' }),
        2
      )
    ];
    const engineA = new ReplayEngine(base);
    const cursorA = { ingestSequence: 2, eventTime: 1000 };
    const digestA = computeDigest(engineA, cursorA, base);
    expect(digestA.errorPathCount).toBe(0);

    const withFailure: LedgerRecord[] = [
      ...base,
      asRecord(
        event({
          spanId: 'pay',
          parentSpanId: 'gw',
          service: 'payment',
          revision: 2,
          eventTime: 260,
          status: 'error',
          errorMessage: 'timeout'
        }),
        3
      ),
      asRecord(
        event({
          spanId: 'gw',
          revision: 2,
          eventTime: 280,
          status: 'error',
          errorMessage: 'downstream failed'
        }),
        4
      ),
      asRecord(
        event({
          spanId: 'new',
          parentSpanId: 'gw',
          service: 'notifier',
          revision: 1,
          eventTime: 300,
          status: 'ok'
        }),
        5
      )
    ];
    const engineB = new ReplayEngine(withFailure);
    const cursorB = { ingestSequence: 5, eventTime: 1000 };
    const diff = diffCursors(engineB, cursorA, cursorB);

    expect(diff.summary.addedCount).toBe(1);
    expect(diff.added[0]!.spanId).toBe('new');
    expect(diff.summary.statusChangedCount).toBe(2);
    const payChange = diff.statusChanged.find((s) => s.spanId === 'pay');
    expect(payChange?.beforeStatus).toBe('ok');
    expect(payChange?.afterStatus).toBe('error');
    expect(diff.summary.removedCount).toBe(0);
    expect(diff.criticalPathChanges.length).toBeGreaterThanOrEqual(1);
  });

  it('reports removed spans when cursor B is earlier than A', () => {
    const records: LedgerRecord[] = [
      asRecord(event({ spanId: 'a', revision: 1, eventTime: 100 }), 1),
      asRecord(event({ spanId: 'b', revision: 1, eventTime: 200, service: 'payment' }), 2)
    ];
    const engine = new ReplayEngine(records);
    const diff = diffCursors(
      engine,
      { ingestSequence: 2, eventTime: 1000 },
      { ingestSequence: 1, eventTime: 1000 }
    );
    expect(diff.summary.removedCount).toBe(1);
    expect(diff.removed[0]!.spanId).toBe('b');
  });

  it('revision change without status change is classified as revision-changed', () => {
    const r1 = asRecord(event({ spanId: 'a', revision: 1, eventTime: 100, operation: 'v1' }), 1);
    const r2 = asRecord(event({ spanId: 'a', revision: 2, eventTime: 200, operation: 'v2' }), 2);
    const engine = new ReplayEngine([r1, r2]);
    const diff = diffCursors(
      engine,
      { ingestSequence: 1, eventTime: 1000 },
      { ingestSequence: 2, eventTime: 1000 }
    );
    expect(diff.summary.statusChangedCount).toBe(0);
    expect(diff.summary.revisionChangedCount).toBe(1);
  });
});
