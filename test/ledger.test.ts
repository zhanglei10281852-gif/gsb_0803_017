import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore } from '../src/server/db.js';
import { makeRawSpanEvent } from '../src/shared/contracts.js';
import { tempDbPath, cleanupPath } from './util.js';

const dbPaths: string[] = [];

function makeSpan(traceId: string, spanId: string, revision = 1, eventTime = 1000) {
  return makeRawSpanEvent({
    traceId,
    spanId,
    parentSpanId: null,
    revision,
    eventTime,
    service: 'svc-a',
    operation: 'op',
    status: 'ok',
    errorMessage: null,
    attributes: {},
  });
}

afterEach(() => {
  for (const p of dbPaths) cleanupPath(p);
  dbPaths.length = 0;
});

describe('LedgerStore', () => {
  test('assigns strictly monotonic ingestSequence', () => {
    const p = tempDbPath('monotonic');
    dbPaths.push(p);
    const store = new LedgerStore(p);
    const r1 = store.append(makeSpan('t1', 's1'));
    const r2 = store.append(makeSpan('t1', 's2'));
    const r3 = store.append(makeSpan('t1', 's3'));
    assert.equal(r1.ingestSequence, 1);
    assert.equal(r2.ingestSequence, 2);
    assert.equal(r3.ingestSequence, 3);
    store.close();
  });

  test('appendMany assigns sequential sequences in one transaction', () => {
    const p = tempDbPath('batch');
    dbPaths.push(p);
    const store = new LedgerStore(p);
    const records = store.appendMany([makeSpan('t', 'a'), makeSpan('t', 'b'), makeSpan('t', 'c')]);
    assert.deepEqual(records.map((r) => r.ingestSequence), [1, 2, 3]);
    store.close();
  });

  test('reopens and resumes sequence without reusing old values', () => {
    const p = tempDbPath('reopen');
    dbPaths.push(p);
    const store1 = new LedgerStore(p);
    store1.append(makeSpan('t', 's1'));
    store1.append(makeSpan('t', 's2'));
    store1.close();

    const store2 = new LedgerStore(p);
    assert.equal(store2.count(), 2);
    const r3 = store2.append(makeSpan('t', 's3'));
    assert.equal(r3.ingestSequence, 3, 'sequence must resume after max persisted value');
    assert.equal(store2.count(), 3);
    store2.close();
  });

  test('ledger is append-only: all revisions retained including duplicates', () => {
    const p = tempDbPath('append');
    dbPaths.push(p);
    const store = new LedgerStore(p);
    store.append(makeSpan('t', 's1', 1, 1000));
    store.append(makeSpan('t', 's1', 1, 1000));
    store.append(makeSpan('t', 's1', 2, 1000));
    const records = store.getAllRecords();
    assert.equal(records.length, 3, 'all three records (including duplicate) must be retained');
    assert.deepEqual(records.map((r) => r.event.revision), [1, 1, 2]);
    store.close();
  });

  test('getRecordsSince returns only newer records', () => {
    const p = tempDbPath('since');
    dbPaths.push(p);
    const store = new LedgerStore(p);
    store.appendMany([makeSpan('t', 'a'), makeSpan('t', 'b'), makeSpan('t', 'c'), makeSpan('t', 'd')]);
    const since = store.getRecordsSince(2);
    assert.deepEqual(since.map((r) => r.ingestSequence), [3, 4]);
    store.close();
  });

  test('rejects contract version mismatch via parser', async () => {
    const { parseRawSpanEvent } = await import('../src/shared/contracts.js');
    assert.throws(() => parseRawSpanEvent({ contractVersion: 99, traceId: 't', spanId: 's', parentSpanId: null, revision: 1, eventTime: 1, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} }));
  });
});
