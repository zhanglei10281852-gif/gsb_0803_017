import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore } from '../src/server/db.js';
import { ReplayEngine } from '../src/server/replay.js';
import { parseNdjsonBody } from '../src/server/ingest.js';
import { makeRawSpanEvent, CONTRACT_VERSION } from '../src/shared/contracts.js';
import { tempDbPath, cleanupPath } from './util.js';

const paths: string[] = [];

function newEngine(label: string): ReplayEngine {
  const p = tempDbPath(label);
  paths.push(p);
  return new ReplayEngine(new LedgerStore(p));
}

afterEach(() => {
  for (const p of paths) cleanupPath(p);
  paths.length = 0;
});

describe('ReplayEngine', () => {
  test('ingest assigns sequence and notifies subscribers', () => {
    const engine = newEngine('sub');
    const received: number[] = [];
    engine.subscribe((record) => received.push(record.ingestSequence));
    engine.ingest(makeRawSpanEvent({
      traceId: 't', spanId: 'a', parentSpanId: null, revision: 1, eventTime: 100,
      service: 'svc', operation: 'op', status: 'ok', errorMessage: null, attributes: {},
    }));
    engine.ingest(makeRawSpanEvent({
      traceId: 't', spanId: 'b', parentSpanId: null, revision: 1, eventTime: 101,
      service: 'svc', operation: 'op', status: 'ok', errorMessage: null, attributes: {},
    }));
    assert.deepEqual(received, [1, 2]);
    engine.close();
  });

  test('unsubscribe stops notifications', () => {
    const engine = newEngine('unsub');
    let count = 0;
    const unsub = engine.subscribe(() => count++);
    engine.ingest(makeRawSpanEvent({
      traceId: 't', spanId: 'a', parentSpanId: null, revision: 1, eventTime: 100,
      service: 'svc', operation: 'op', status: 'ok', errorMessage: null, attributes: {},
    }));
    unsub();
    engine.ingest(makeRawSpanEvent({
      traceId: 't', spanId: 'b', parentSpanId: null, revision: 1, eventTime: 101,
      service: 'svc', operation: 'op', status: 'ok', errorMessage: null, attributes: {},
    }));
    assert.equal(count, 1);
    engine.close();
  });

  test('getView at a cursor excludes future records', () => {
    const engine = newEngine('cursor');
    engine.ingestMany([
      makeRawSpanEvent({ traceId: 't', spanId: 'a', parentSpanId: null, revision: 1, eventTime: 100, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} }),
      makeRawSpanEvent({ traceId: 't', spanId: 'b', parentSpanId: null, revision: 1, eventTime: 200, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} }),
    ]);
    const view = engine.getView({ eventTime: 150, ingestSequence: 2 });
    assert.equal(view.spans.length, 1);
    assert.equal(view.spans[0]!.spanId, 'a');
    engine.close();
  });
});

describe('parseNdjsonBody', () => {
  test('parses newline-delimited JSON', () => {
    const body = [
      JSON.stringify({ contractVersion: CONTRACT_VERSION, traceId: 't', spanId: 'a', parentSpanId: null, revision: 1, eventTime: 1, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} }),
      JSON.stringify({ contractVersion: CONTRACT_VERSION, traceId: 't', spanId: 'b', parentSpanId: null, revision: 1, eventTime: 2, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} }),
    ].join('\n');
    const { events, errors } = parseNdjsonBody(body);
    assert.equal(events.length, 2);
    assert.equal(errors.length, 0);
  });

  test('parses JSON array', () => {
    const body = JSON.stringify([
      { contractVersion: CONTRACT_VERSION, traceId: 't', spanId: 'a', parentSpanId: null, revision: 1, eventTime: 1, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} },
    ]);
    const { events, errors } = parseNdjsonBody(body);
    assert.equal(events.length, 1);
    assert.equal(errors.length, 0);
  });

  test('reports per-line errors without throwing', () => {
    const body = [
      JSON.stringify({ contractVersion: CONTRACT_VERSION, traceId: 't', spanId: 'a', parentSpanId: null, revision: 1, eventTime: 1, service: 's', operation: 'o', status: 'ok', errorMessage: null, attributes: {} }),
      'not json',
      JSON.stringify({ contractVersion: 99, traceId: 't', spanId: 'b' }),
    ].join('\n');
    const { events, errors } = parseNdjsonBody(body);
    assert.equal(events.length, 1);
    assert.equal(errors.length, 2);
  });

  test('handles empty body', () => {
    const { events, errors } = parseNdjsonBody('');
    assert.equal(events.length, 0);
    assert.equal(errors.length, 0);
  });
});
