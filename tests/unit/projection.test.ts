import { describe, it, expect } from 'vitest';
import { projectView, computeBounds } from '../../src/shared/projection';
import type { LedgerRecord, ReplayCursor } from '../../src/shared/contract';
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

const fullCursor = (records: LedgerRecord[]): ReplayCursor => {
  const b = computeBounds(records);
  return { eventTimeMs: b.maxEventTimeMs, ingestSequence: b.maxIngestSequence };
};

describe('projection: revision resolution', () => {
  it('higher revision supersedes lower as current version', () => {
    const records: LedgerRecord[] = [
      rec({ spanId: 'a', revision: 0, ingestSequence: 1, status: 'ok' }),
      rec({ spanId: 'a', revision: 1, ingestSequence: 2, status: 'error', errorKind: 'X' }),
    ];
    const view = projectView(records, fullCursor(records));
    expect(view.spans).toHaveLength(1);
    expect(view.spans[0]!.revision).toBe(1);
    expect(view.spans[0]!.status).toBe('error');
    expect(view.spans[0]!.versionReason.knownRevisions).toBe(2);
  });

  it('equal revision keeps the earlier arrival (tie never wins)', () => {
    const records: LedgerRecord[] = [
      rec({ spanId: 'a', revision: 0, ingestSequence: 5, operation: 'first' }),
      rec({ spanId: 'a', revision: 0, ingestSequence: 6, operation: 'second' }),
    ];
    const view = projectView(records, fullCursor(records));
    expect(view.spans[0]!.operation).toBe('first');
    expect(view.spans[0]!.ingestSequence).toBe(5);
  });
});

describe('projection: reproducibility & ordering independence', () => {
  const build = (): LedgerRecord[] => [
    rec({ spanId: 'root', parentSpanId: null, ingestSequence: 1, eventTimeMs: 100 }),
    rec({ spanId: 'child', parentSpanId: 'root', ingestSequence: 2, eventTimeMs: 200 }),
    rec({ spanId: 'child', parentSpanId: 'root', revision: 1, ingestSequence: 3, eventTimeMs: 200, status: 'error' }),
  ];

  it('is independent of input order (late/out-of-order/duplicate)', () => {
    const base = build();
    const cursor = fullCursor(base);
    const forward = projectView(base, cursor);

    const shuffled = [base[2]!, base[0]!, base[1]!, base[0]!]; // reversed + duplicate
    const backward = projectView(shuffled, cursor);

    expect(JSON.stringify(backward.spans)).toEqual(JSON.stringify(forward.spans));
    expect(JSON.stringify(backward.edges)).toEqual(JSON.stringify(forward.edges));
  });

  it('same cursor always yields identical view', () => {
    const records = build();
    const cursor: ReplayCursor = { eventTimeMs: 200, ingestSequence: 2 };
    const a = projectView(records, cursor);
    const b = projectView(records, cursor);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('projection: cursor semantics', () => {
  const records: LedgerRecord[] = [
    rec({ spanId: 'a', revision: 0, ingestSequence: 1, eventTimeMs: 100, status: 'ok' }),
    rec({ spanId: 'a', revision: 1, ingestSequence: 3, eventTimeMs: 100, status: 'error' }),
    rec({ spanId: 'b', parentSpanId: 'a', ingestSequence: 2, eventTimeMs: 300 }),
  ];

  it('ingestSequence gates knowledge: earlier cursor sees the pre-correction version', () => {
    const view = projectView(records, { eventTimeMs: 100, ingestSequence: 1 });
    const a = view.spans.find((s) => s.spanId === 'a')!;
    expect(a.revision).toBe(0);
    expect(a.status).toBe('ok');
    expect(a.versionReason.supersededLater).toBe(true);
    expect(a.versionReason.latestRevisionEver).toBe(1);
  });

  it('advancing ingestSequence reveals the correction', () => {
    const view = projectView(records, { eventTimeMs: 100, ingestSequence: 3 });
    const a = view.spans.find((s) => s.spanId === 'a')!;
    expect(a.revision).toBe(1);
    expect(a.status).toBe('error');
    expect(a.versionReason.supersededLater).toBe(false);
  });

  it('eventTime gates timeline: future spans are hidden', () => {
    const view = projectView(records, { eventTimeMs: 100, ingestSequence: 3 });
    expect(view.spans.find((s) => s.spanId === 'b')).toBeUndefined();
    const later = projectView(records, { eventTimeMs: 300, ingestSequence: 3 });
    expect(later.spans.find((s) => s.spanId === 'b')).toBeDefined();
  });
});

describe('projection: error propagation', () => {
  it('marks ancestors of an errored span as on the error path', () => {
    const records: LedgerRecord[] = [
      rec({ spanId: 'root', parentSpanId: null, ingestSequence: 1 }),
      rec({ spanId: 'mid', parentSpanId: 'root', ingestSequence: 2 }),
      rec({ spanId: 'leaf', parentSpanId: 'mid', ingestSequence: 3, status: 'error', errorKind: 'boom' }),
    ];
    const view = projectView(records, fullCursor(records));
    const byId = new Map(view.spans.map((s) => [s.spanId, s]));
    expect(byId.get('leaf')!.onErrorPath).toBe(true);
    expect(byId.get('mid')!.onErrorPath).toBe(true);
    expect(byId.get('root')!.onErrorPath).toBe(true);

    const edgeToLeaf = view.edges.find((e) => e.toSpanId === 'leaf')!;
    expect(edgeToLeaf.propagatesError).toBe(true);
  });
});
