import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpanEvent } from '../../src/shared/contracts';
import { validateSpanEvent } from '../../src/shared/validation';
import { LedgerStore } from '../../src/server/ledgerStore';
import { ReplayEngine } from '../../src/server/replayEngine';

function event(partial: Partial<SpanEvent> & { spanId: string; revision: number; eventTime: number }): SpanEvent {
  return {
    contractVersion: 1,
    traceId: 't1',
    spanId: partial.spanId,
    parentSpanId: partial.parentSpanId ?? null,
    service: partial.service ?? 'svc-a',
    operation: partial.operation ?? 'op',
    kind: partial.kind ?? 'server',
    status: partial.status ?? 'ok',
    startTime: partial.startTime ?? partial.eventTime,
    endTime: partial.endTime ?? partial.eventTime + 10,
    revision: partial.revision,
    eventTime: partial.eventTime,
    errorMessage: partial.errorMessage,
    attributes: partial.attributes ?? {}
  };
}

describe('LedgerStore', () => {
  let dir: string;
  let store: LedgerStore;
  let extra: LedgerStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    store = new LedgerStore(join(dir, 'replay.db'));
    extra = null;
  });

  afterEach(() => {
    store.close();
    if (extra) extra.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns strictly monotonic ingestSequence even across batches', () => {
    const first = store.append([event({ spanId: 'a', revision: 1, eventTime: 100 })]);
    const second = store.append([event({ spanId: 'b', revision: 1, eventTime: 200 })]);
    expect(first.records[0]!.ingestSequence).toBe(1);
    expect(second.records[0]!.ingestSequence).toBe(2);
  });

  it('keeps all revisions in append-only ledger', () => {
    store.append([event({ spanId: 'a', revision: 1, eventTime: 100, status: 'ok' })]);
    store.append([event({ spanId: 'a', revision: 2, eventTime: 150, status: 'error' })]);
    const versions = store.loadVersions('t1', 'a');
    expect(versions).toHaveLength(2);
    expect(versions[0]!.revision).toBe(1);
    expect(versions[1]!.revision).toBe(2);
  });

  it('recovers after close/reopen without re-ingesting', () => {
    store.append([event({ spanId: 'a', revision: 1, eventTime: 100 })]);
    store.append([event({ spanId: 'a', revision: 2, eventTime: 200, status: 'error' })]);
    const infoBefore = store.getInfo();
    store.close();

    extra = new LedgerStore(join(dir, 'replay.db'));
    const infoAfter = extra.getInfo();
    expect(infoAfter.totalRecords).toBe(infoBefore.totalRecords);
    expect(infoAfter.maxIngestSequence).toBe(infoBefore.maxIngestSequence);
    const all = extra.loadAll();
    expect(all).toHaveLength(2);
  });

  it('continues monotonic sequence after reopen', () => {
    store.append([event({ spanId: 'a', revision: 1, eventTime: 100 })]);
    store.close();
    extra = new LedgerStore(join(dir, 'replay.db'));
    const appended = extra.append([event({ spanId: 'b', revision: 1, eventTime: 200 })]);
    expect(appended.records[0]!.ingestSequence).toBe(2);
  });
});

describe('ReplayEngine determinism', () => {
  it('higher revision wins only when visible at cursor', () => {
    const records = [
      { seq: 1, spanId: 'a', revision: 1, eventTime: 100, status: 'ok' as const },
      { seq: 2, spanId: 'a', revision: 2, eventTime: 500, status: 'error' as const },
      { seq: 3, spanId: 'a', revision: 3, eventTime: 900, status: 'error' as const }
    ].map((r, idx) => ({
      ingestSequence: r.seq,
      traceId: 't1',
      spanId: r.spanId,
      parentSpanId: null,
      service: 'gateway',
      operation: 'op',
      kind: 'server' as const,
      status: r.status,
      startTime: 0,
      endTime: 10,
      revision: r.revision,
      eventTime: r.eventTime,
      errorMessage: null,
      attributes: {},
      receivedAt: idx
    }));

    const engine = new ReplayEngine(records);

    const atSeq2 = engine.buildView({ ingestSequence: 2, eventTime: 1000 }, false);
    expect(atSeq2.spans[0]!.revision).toBe(2);
    expect(atSeq2.spans[0]!.status).toBe('error');
    expect(atSeq2.spans[0]!.effectiveReason.kind).toBe('newest-revision');

    const atSeq1 = engine.buildView({ ingestSequence: 1, eventTime: 1000 }, false);
    expect(atSeq1.spans[0]!.revision).toBe(1);
    expect(atSeq1.spans[0]!.status).toBe('ok');
  });

  it('duplicate same revision keeps earliest ingestSequence (idempotent)', () => {
    const records = [
      { seq: 5, revision: 1 },
      { seq: 8, revision: 1 }
    ].map((r, idx) => ({
      ingestSequence: r.seq,
      traceId: 't1',
      spanId: 'dup',
      parentSpanId: null,
      service: 'payment',
      operation: 'charge',
      kind: 'server' as const,
      status: 'ok' as const,
      startTime: 0,
      endTime: 10,
      revision: r.revision,
      eventTime: 100,
      errorMessage: null,
      attributes: {},
      receivedAt: idx
    }));
    const engine = new ReplayEngine(records);
    const view = engine.buildView({ ingestSequence: 10, eventTime: 1000 }, false);
    expect(view.spans[0]!.revision).toBe(1);
    expect(view.spans[0]!.activeAt.ingestSequence).toBe(5);
    expect(view.spans[0]!.effectiveReason.kind).toBe('first-seen');
  });

  it('rebuilds identical view for same cursor regardless of late arrivals', () => {
    const base = [
      { seq: 1, spanId: 'a', revision: 1, eventTime: 100 },
      { seq: 2, spanId: 'b', revision: 1, eventTime: 200 }
    ];
    const withLate = [
      ...base,
      { seq: 3, spanId: 'c', revision: 1, eventTime: 900 }
    ];
    const toRecords = (rows: typeof base) =>
      rows.map((r, idx) => ({
        ingestSequence: r.seq,
        traceId: 't1',
        spanId: r.spanId,
        parentSpanId: null,
        service: r.spanId === 'a' ? 'gateway' : 'payment',
        operation: 'op',
        kind: 'server' as const,
        status: 'ok' as const,
        startTime: 0,
        endTime: 10,
        revision: r.revision,
        eventTime: r.eventTime,
        errorMessage: null,
        attributes: {},
        receivedAt: idx
      }));
    const viewA = new ReplayEngine(toRecords(base)).buildView({ ingestSequence: 2, eventTime: 1000 }, false);
    const viewB = new ReplayEngine(toRecords(withLate)).buildView({ ingestSequence: 2, eventTime: 1000 }, false);
    expect(viewA.spans.map((s) => s.spanId)).toEqual(['a', 'b']);
    expect(viewB.spans.map((s) => s.spanId)).toEqual(['a', 'b']);
  });

  it('eventTime gate hides late spans even with high ingestSequence', () => {
    const records = [
      { seq: 1, spanId: 'a', revision: 1, eventTime: 100 },
      { seq: 2, spanId: 'late', revision: 1, eventTime: 9000 }
    ].map((r, idx) => ({
      ingestSequence: r.seq,
      traceId: 't1',
      spanId: r.spanId,
      parentSpanId: null,
      service: 'svc',
      operation: 'op',
      kind: 'server' as const,
      status: 'ok' as const,
      startTime: 0,
      endTime: 10,
      revision: 1,
      eventTime: r.eventTime,
      errorMessage: null,
      attributes: {},
      receivedAt: idx
    }));
    const engine = new ReplayEngine(records);
    const view = engine.buildView({ ingestSequence: 2, eventTime: 500 }, false);
    expect(view.spans.map((s) => s.spanId)).toEqual(['a']);
  });

  it('builds error propagation path up to root', () => {
    const rows = [
      { seq: 1, spanId: 'root', parent: null, service: 'gateway', status: 'error' as const, eventTime: 100 },
      { seq: 2, spanId: 'mid', parent: 'root', service: 'payment', status: 'error' as const, eventTime: 200 },
      { seq: 3, spanId: 'leaf', parent: 'mid', service: 'inventory', status: 'error' as const, eventTime: 300 },
      { seq: 4, spanId: 'okchild', parent: 'mid', service: 'fraud', status: 'ok' as const, eventTime: 400 }
    ];
    const records = rows.map((r, idx) => ({
      ingestSequence: r.seq,
      traceId: 't1',
      spanId: r.spanId,
      parentSpanId: r.parent,
      service: r.service,
      operation: 'op',
      kind: 'server' as const,
      status: r.status,
      startTime: 0,
      endTime: 10,
      revision: 1,
      eventTime: r.eventTime,
      errorMessage: r.status === 'error' ? 'fail' : null,
      attributes: {},
      receivedAt: idx
    }));
    const engine = new ReplayEngine(records);
    const view = engine.buildView({ ingestSequence: 10, eventTime: 1000 }, false);
    const leafPath = view.errorPaths.find((p) => p.originSpanId === 'leaf');
    expect(leafPath?.path).toEqual(['root', 'mid', 'leaf']);
    expect(leafPath?.affectedServices).toEqual(['gateway', 'inventory', 'payment']);
  });
});

describe('validation', () => {
  it('rejects malformed events and missing contractVersion', () => {
    expect(validateSpanEvent({}).ok).toBe(false);
    expect(validateSpanEvent({ contractVersion: 99 }).ok).toBe(false);
  });

  it('accepts a valid event', () => {
    const result = validateSpanEvent({
      contractVersion: 1,
      traceId: 't',
      spanId: 's',
      parentSpanId: null,
      service: 'svc',
      operation: 'op',
      kind: 'server',
      status: 'ok',
      startTime: 1,
      endTime: 2,
      revision: 0,
      eventTime: 3
    });
    expect(result.ok).toBe(true);
  });
});
