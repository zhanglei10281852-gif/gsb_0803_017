import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayView, computeHead } from '../src/shared/projection.js';
import { generateSampleStream } from '../src/server/sampleStream.js';
import { LedgerStore } from '../src/server/db.js';
import { ReplayEngine } from '../src/server/replay.js';
import type { LedgerRecord, ReplayCursor } from '../src/shared/contracts.js';
import { tempDbPath, cleanupPath } from './util.js';

const dbPaths: string[] = [];

function cleanup(): void {
  for (const p of dbPaths) cleanupPath(p);
  dbPaths.length = 0;
}

describe('determinism', () => {
  test('same cursor produces identical view regardless of ingest order permutations', () => {
    const base = 1_000_000;
    const events = generateSampleStream(base).map((s) => s.event);

    function buildView(ordered: typeof events): ReturnType<typeof buildReplayView> {
      const records: LedgerRecord[] = ordered.map((event, i) => ({
        ingestSequence: i + 1,
        ingestTime: base + i * 100,
        event,
      }));
      const head = computeHead(records);
      return buildReplayView(records, head);
    }

    const view1 = buildView(events);

    const shuffled = [...events].reverse();
    const view2 = buildView(shuffled);

    assert.equal(view2.spans.length, view1.spans.length, 'same number of current spans');
    const sig1 = view1.spans
      .map((s) => `${s.traceId}:${s.spanId}:${s.revision}:${s.status}`)
      .sort()
      .join('|');
    const sig2 = view2.spans
      .map((s) => `${s.traceId}:${s.spanId}:${s.revision}:${s.status}`)
      .sort()
      .join('|');
    assert.equal(sig2, sig1, 'current versions must be independent of ingest order at head');
  });

  test('repeated calls with the same cursor return identical results', () => {
    const base = 2_000_000;
    const events = generateSampleStream(base).map((s) => s.event);
    const records: LedgerRecord[] = events.map((event, i) => ({
      ingestSequence: i + 1,
      ingestTime: base + i * 100,
      event,
    }));
    const cursor: ReplayCursor = { eventTime: base + 800, ingestSequence: 20 };
    const a = buildReplayView(records, cursor);
    const b = buildReplayView(records, cursor);
    assert.deepEqual(b, a);
  });

  test('advancing ingest horizon reveals late spans and revisions', () => {
    const base = 3_000_000;
    const stream = generateSampleStream(base);
    const records: LedgerRecord[] = stream.map((s, i) => ({
      ingestSequence: i + 1,
      ingestTime: base + s.ingestAfterMs,
      event: s.event,
    }));

    const beforeRev2: ReplayCursor = { eventTime: base + 10000, ingestSequence: 7 };
    const afterRev2: ReplayCursor = { eventTime: base + 10000, ingestSequence: 20 };

    const paymentsBefore = buildReplayView(records, beforeRev2).spans.find(
      (s) => s.spanId === 's4' && s.traceId.startsWith('trace-incident'),
    );
    const paymentsAfter = buildReplayView(records, afterRev2).spans.find(
      (s) => s.spanId === 's4' && s.traceId.startsWith('trace-incident'),
    );

    assert.ok(paymentsBefore, 'payments span visible before correction');
    assert.ok(paymentsAfter, 'payments span visible after correction');
    assert.equal(paymentsBefore!.status, 'ok', 'rev1 reports ok');
    assert.equal(paymentsBefore!.revision, 1);
    assert.equal(paymentsAfter!.status, 'error', 'rev2 corrects to error');
    assert.equal(paymentsAfter!.revision, 2);
  });

  test('sample stream is deterministic across generations', () => {
    const a = generateSampleStream(42);
    const b = generateSampleStream(42);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i]!.ingestAfterMs, b[i]!.ingestAfterMs);
      assert.equal(JSON.stringify(a[i]!.event), JSON.stringify(b[i]!.event));
    }
  });

  test('engine rebuilds the same projection after close and reopen', () => {
    const p = tempDbPath('rebuild');
    dbPaths.push(p);
    const base = 4_000_000;

    const store1 = new LedgerStore(p);
    const engine1 = new ReplayEngine(store1);
    for (const s of generateSampleStream(base)) {
      engine1.ingest(s.event);
    }
    const head1 = engine1.getHead();
    const view1 = engine1.getViewAtHead();
    engine1.close();

    const store2 = new LedgerStore(p);
    const engine2 = new ReplayEngine(store2);
    const head2 = engine2.getHead();
    const view2 = engine2.getViewAtHead();

    assert.deepEqual(head2, head1, 'head cursor must be recovered from SQLite');
    assert.equal(engine2.totalRecords(), view1.totalLedgerRecords, 'all ledger records restored');
    assert.equal(view2.spans.length, view1.spans.length, 'rebuilt projection has same span count');
    const sig1 = view1.spans.map((s) => `${s.spanId}:${s.revision}:${s.status}`).sort().join('|');
    const sig2 = view2.spans.map((s) => `${s.spanId}:${s.revision}:${s.status}`).sort().join('|');
    assert.equal(sig2, sig1, 'rebuilt projection is identical');
    engine2.close();
    cleanup();
  });
});
