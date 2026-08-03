import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplayView,
  projectSpans,
  explainSpanVersions,
  findErrorPropagationPath,
  isRecordVisible,
} from '../src/shared/projection.js';
import { makeRawSpanEvent, type LedgerRecord, type ReplayCursor } from '../src/shared/contracts.js';

function rec(
  seq: number,
  traceId: string,
  spanId: string,
  revision: number,
  eventTime: number,
  opts: Partial<{
    parentSpanId: string | null;
    service: string;
    operation: string;
    status: 'ok' | 'error';
    errorMessage: string | null;
    ingestTime: number;
  }> = {},
): LedgerRecord {
  const ingestTime = opts.ingestTime ?? eventTime + 50;
  return {
    ingestSequence: seq,
    ingestTime,
    event: makeRawSpanEvent({
      traceId,
      spanId,
      parentSpanId: opts.parentSpanId ?? null,
      revision,
      eventTime,
      service: opts.service ?? 'svc',
      operation: opts.operation ?? 'op',
      status: opts.status ?? 'ok',
      errorMessage: opts.errorMessage ?? null,
      attributes: {},
    }),
  };
}

describe('projection', () => {
  test('higher revision becomes current; lower revision is ignored', () => {
    const records = [
      rec(1, 't', 's', 1, 100, { status: 'ok' }),
      rec(2, 't', 's', 2, 100, { status: 'error', errorMessage: 'boom' }),
      rec(3, 't', 's', 1, 100, { status: 'ok' }),
    ];
    const spans = projectSpans(records);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.revision, 2);
    assert.equal(spans[0]!.status, 'error');
  });

  test('duplicate same revision does not replace current (first wins on tie)', () => {
    const records = [
      rec(1, 't', 's', 1, 100, { service: 'first' }),
      rec(2, 't', 's', 1, 100, { service: 'second' }),
    ];
    const spans = projectSpans(records);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.service, 'first', 'duplicate with same revision must not override');
  });

  test('late-arriving span is invisible before its ingestSequence but visible after', () => {
    const records = [
      rec(1, 't', 's1', 1, 100, { ingestTime: 150 }),
      rec(2, 't', 's2', 1, 50, { ingestTime: 5000 }),
    ];
    const before: ReplayCursor = { eventTime: 1000, ingestSequence: 1 };
    const after: ReplayCursor = { eventTime: 1000, ingestSequence: 2 };
    const viewBefore = buildReplayView(records, before);
    const viewAfter = buildReplayView(records, after);
    assert.equal(viewBefore.spans.length, 1, 'late span hidden before its ingest sequence');
    assert.equal(viewAfter.spans.length, 2, 'late span visible after its ingest sequence');
  });

  test('explainSpanVersions marks current, duplicate, and late versions', () => {
    const records = [
      rec(1, 't', 's', 1, 100, { ingestTime: 150, status: 'ok' }),
      rec(2, 't', 's', 1, 100, { ingestTime: 200, status: 'ok' }),
      rec(3, 't', 's', 2, 100, { ingestTime: 5000, status: 'error', errorMessage: 'corrected' }),
    ];
    const versions = explainSpanVersions(records, 't', 's', { eventTime: 10000, ingestSequence: 3 });
    assert.equal(versions.length, 3);
    const current = versions.find((v) => v.isCurrent);
    assert.ok(current);
    assert.equal(current!.revision, 2);
    assert.equal(current!.becameCurrentAt, 3);
    const dup = versions.find((v) => v.isDuplicate);
    assert.ok(dup, 'duplicate revision must be flagged');
    assert.equal(dup!.ingestSequence, 2);
    const late = versions.find((v) => v.arrivalDelayMs > 1000);
    assert.ok(late, 'late arrival must be flagged');
  });

  test('isRecordVisible respects both eventTime and ingestSequence', () => {
    const r = rec(5, 't', 's', 1, 1000, { ingestTime: 1050 });
    assert.equal(isRecordVisible(r, { eventTime: 999, ingestSequence: 10 }), false);
    assert.equal(isRecordVisible(r, { eventTime: 1000, ingestSequence: 4 }), false);
    assert.equal(isRecordVisible(r, { eventTime: 1000, ingestSequence: 5 }), true);
  });

  test('builds topology edges from parent relationships', () => {
    const records = [
      rec(1, 't', 'root', 1, 100, { service: 'gateway' }),
      rec(2, 't', 'child', 1, 110, { service: 'auth', parentSpanId: 'root' }),
      rec(3, 't', 'grand', 1, 120, { service: 'db', parentSpanId: 'child', status: 'error' }),
    ];
    const view = buildReplayView(records, { eventTime: 1000, ingestSequence: 3 });
    assert.equal(view.services.length, 3);
    assert.equal(view.edges.length, 2);
    const errorEdge = view.edges.find((e) => e.hasError);
    assert.ok(errorEdge);
    assert.equal(errorEdge!.toService, 'db');
  });

  test('findErrorPropagationPath walks up parent chain', () => {
    const records = [
      rec(1, 't', 'root', 1, 100, { service: 'gateway' }),
      rec(2, 't', 'child', 1, 110, { service: 'auth', parentSpanId: 'root' }),
      rec(3, 't', 'grand', 1, 120, { service: 'db', parentSpanId: 'child', status: 'error' }),
    ];
    const view = buildReplayView(records, { eventTime: 1000, ingestSequence: 3 });
    const path = findErrorPropagationPath(view.spans, 't', 'grand');
    assert.deepEqual(path.map((s) => s.spanId), ['grand', 'child', 'root']);
  });

  test('arrivalDelayMs is computed from ingestTime - eventTime', () => {
    const records = [rec(1, 't', 's', 1, 1000, { ingestTime: 5000 })];
    const spans = projectSpans(records);
    assert.equal(spans[0]!.arrivalDelayMs, 4000);
  });
});
