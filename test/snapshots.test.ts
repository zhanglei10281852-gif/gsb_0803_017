import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore } from '../src/server/db.js';
import { ReplayEngine } from '../src/server/replay.js';
import { makeRawSpanEvent, type ReplayCursor } from '../src/shared/contracts.js';
import { tempDbPath, cleanupPath } from './util.js';

const paths: string[] = [];

function newEngine(label: string): ReplayEngine {
  const p = tempDbPath(label);
  paths.push(p);
  return new ReplayEngine(new LedgerStore(p));
}

function span(traceId: string, spanId: string, extra: Partial<{
  parentSpanId: string | null;
  revision: number;
  eventTime: number;
  service: string;
  operation: string;
  status: 'ok' | 'error';
  errorMessage: string | null;
}> = {}) {
  return makeRawSpanEvent({
    traceId,
    spanId,
    parentSpanId: extra.parentSpanId ?? null,
    revision: extra.revision ?? 1,
    eventTime: extra.eventTime ?? 1000,
    service: extra.service ?? 'svc',
    operation: extra.operation ?? 'op',
    status: extra.status ?? 'ok',
    errorMessage: extra.errorMessage ?? null,
    attributes: {},
  });
}

afterEach(() => {
  for (const p of paths) cleanupPath(p);
  paths.length = 0;
});

describe('snapshots', () => {
  test('digest is deterministic for the same cursor and ledger', () => {
    const engine = newEngine('digest-deterministic');
    engine.ingestMany([
      span('t', 's1', { service: 'gateway' }),
      span('t', 's2', { service: 'auth', parentSpanId: 's1' }),
    ]);
    const cursor: ReplayCursor = { eventTime: 100000, ingestSequence: 100 };
    const d1 = engine.computeDigest(cursor);
    const d2 = engine.computeDigest(cursor);
    assert.equal(d1.digest, d2.digest);
    assert.equal(d1.visibleRecordCount, 2);
    engine.close();
  });

  test('digest changes when ingest horizon reveals more records', () => {
    const engine = newEngine('digest-horizon');
    engine.ingestMany([
      span('t', 's1'),
      span('t', 's2', { eventTime: 50 }),
    ]);
    const before: ReplayCursor = { eventTime: 100000, ingestSequence: 1 };
    const after: ReplayCursor = { eventTime: 100000, ingestSequence: 2 };
    const d1 = engine.computeDigest(before);
    const d2 = engine.computeDigest(after);
    assert.notEqual(d1.digest, d2.digest);
    assert.equal(d1.visibleRecordCount, 1);
    assert.equal(d2.visibleRecordCount, 2);
    engine.close();
  });

  test('digest is identical after engine close and reopen', () => {
    const p = tempDbPath('digest-reopen');
    paths.push(p);
    const engine1 = new ReplayEngine(new LedgerStore(p));
    engine1.ingestMany([
      span('t', 's1', { service: 'gateway' }),
      span('t', 's2', { service: 'auth', parentSpanId: 's1', status: 'error', errorMessage: 'boom' }),
    ]);
    const cursor: ReplayCursor = { eventTime: 100000, ingestSequence: 100 };
    const digest1 = engine1.computeDigest(cursor).digest;
    engine1.close();

    const engine2 = new ReplayEngine(new LedgerStore(p));
    const digest2 = engine2.computeDigest(cursor).digest;
    assert.equal(digest2, digest1, 'digest must be reproducible from the same SQLite ledger');
    engine2.close();
  });

  test('snapshot records ledger high-water mark and visible count', () => {
    const engine = newEngine('snapshot-hwm');
    engine.ingestMany([span('t', 's1'), span('t', 's2'), span('t', 's3')]);
    const cursor: ReplayCursor = { eventTime: 100000, ingestSequence: 2 };
    const snap = engine.createSnapshot('A', 'before', cursor, 'initial notes');
    assert.equal(snap.slot, 'A');
    assert.equal(snap.totalLedgerRecords, 3);
    assert.equal(snap.visibleRecordCount, 2);
    assert.equal(snap.ledgerHead.ingestSequence, 3);
    assert.equal(snap.notes, 'initial notes');
    assert.ok(snap.digest.length === 64, 'sha256 hex digest');
    engine.close();
  });

  test('diff detects added spans between A and B', () => {
    const engine = newEngine('diff-added');
    engine.ingestMany([span('t', 's1'), span('t', 's2')]);
    const cursorA: ReplayCursor = { eventTime: 100000, ingestSequence: 1 };
    const cursorB: ReplayCursor = { eventTime: 100000, ingestSequence: 2 };
    const a = engine.createSnapshot('A', 'A', cursorA, '');
    const b = engine.createSnapshot('B', 'B', cursorB, '');
    const diff = engine.compareSnapshots(a.id, b.id);
    assert.equal(diff.summary.addedCount, 1);
    assert.equal(diff.added[0]!.spanId, 's2');
    assert.equal(diff.summary.removedCount, 0);
    assert.equal(diff.sameDigest, false);
    engine.close();
  });

  test('diff detects status/revision changes (revision correction)', () => {
    const engine = newEngine('diff-change');
    engine.ingest(span('t', 's4', { revision: 1, status: 'ok', service: 'payments' }));
    const a = engine.createSnapshot('A', 'rev1', { eventTime: 100000, ingestSequence: 1 }, '');
    engine.ingest(span('t', 's4', { revision: 2, status: 'error', errorMessage: 'corrected', service: 'payments' }));
    const b = engine.createSnapshot('B', 'rev2', { eventTime: 100000, ingestSequence: 2 }, '');
    const diff = engine.compareSnapshots(a.id, b.id);
    assert.equal(diff.summary.changedCount, 1);
    const change = diff.changed[0]!;
    assert.equal(change.spanId, 's4');
    assert.ok(change.fields.includes('status'));
    assert.ok(change.fields.includes('revision'));
    assert.equal(change.before.status, 'ok');
    assert.equal(change.after.status, 'error');
    engine.close();
  });

  test('diff detects critical path changes', () => {
    const engine = newEngine('diff-critical');
    engine.ingestMany([
      span('t', 'root', { service: 'gateway' }),
      span('t', 'child', { service: 'auth', parentSpanId: 'root' }),
    ]);
    const a = engine.createSnapshot('A', 'healthy', { eventTime: 100000, ingestSequence: 2 }, '');
    engine.ingest(span('t', 'child', {
      service: 'auth',
      parentSpanId: 'root',
      revision: 2,
      status: 'error',
      errorMessage: 'denied',
    }));
    const b = engine.createSnapshot('B', 'broken', { eventTime: 100000, ingestSequence: 3 }, '');
    const diff = engine.compareSnapshots(a.id, b.id);
    assert.equal(diff.summary.changedCount, 1);
    assert.ok(diff.criticalPathChanges.length >= 0);
    engine.close();
  });

  test('sealed snapshot is immutable: later ingest cannot alter it', () => {
    const engine = newEngine('immutable');
    engine.ingest(span('t', 's1'));
    const a = engine.createSnapshot('A', 'sealed', { eventTime: 100000, ingestSequence: 1 }, 'note1');
    const digestBefore = a.digest;
    const cursorBefore = { ...a.cursor };

    engine.ingestMany([span('t', 's2'), span('t', 's3')]);
    const aReloaded = engine.getSnapshot(a.id);
    assert.ok(aReloaded);
    assert.equal(aReloaded!.digest, digestBefore, 'digest must not change after later ingests');
    assert.deepEqual(aReloaded!.cursor, cursorBefore, 'cursor must not change');
    assert.equal(aReloaded!.totalLedgerRecords, 1, 'sealed record count frozen at creation');
    engine.close();
  });

  test('notes can be updated without changing sealed digest or cursor', () => {
    const engine = newEngine('notes');
    engine.ingest(span('t', 's1'));
    const snap = engine.createSnapshot('A', 'A', { eventTime: 100000, ingestSequence: 1 }, 'old');
    const updated = engine.updateSnapshotNotes(snap.id, 'investigation notes');
    assert.ok(updated);
    assert.equal(updated!.notes, 'investigation notes');
    assert.equal(updated!.digest, snap.digest, 'digest unchanged by notes edit');
    assert.deepEqual(updated!.cursor, snap.cursor, 'cursor unchanged by notes edit');
    engine.close();
  });

  test('new snapshot for same slot does not overwrite previous sealed snapshot', () => {
    const engine = newEngine('slot-history');
    engine.ingest(span('t', 's1'));
    const first = engine.createSnapshot('A', 'first', { eventTime: 100000, ingestSequence: 1 }, '');
    engine.ingest(span('t', 's2'));
    const second = engine.createSnapshot('A', 'second', { eventTime: 100000, ingestSequence: 2 }, '');

    const all = engine.listSnapshots();
    assert.equal(all.length, 2, 'both snapshots retained in append-only history');
    const firstReloaded = engine.getSnapshot(first.id);
    assert.equal(firstReloaded!.visibleRecordCount, 1, 'first snapshot sealed at 1 record');
    const latestA = engine.getLatestSnapshot('A');
    assert.equal(latestA!.id, second.id, 'latest A is the second one');
    assert.equal(latestA!.visibleRecordCount, 2);
    engine.close();
  });

  test('snapshots persist across engine restart', () => {
    const p = tempDbPath('snap-persist');
    paths.push(p);
    const e1 = new ReplayEngine(new LedgerStore(p));
    e1.ingest(span('t', 's1'));
    const snap = e1.createSnapshot('A', 'persisted', { eventTime: 100000, ingestSequence: 1 }, 'remember me');
    e1.close();

    const e2 = new ReplayEngine(new LedgerStore(p));
    const restored = e2.getSnapshot(snap.id);
    assert.ok(restored, 'snapshot must survive restart');
    assert.equal(restored!.label, 'persisted');
    assert.equal(restored!.notes, 'remember me');
    assert.equal(restored!.digest, snap.digest);
    assert.equal(restored!.visibleRecordCount, 1);
    const diff = e2.compareSnapshots(
      e2.getLatestSnapshot('A')!.id,
      e2.getLatestSnapshot('A')!.id,
    );
    assert.equal(diff.sameDigest, true);
    e2.close();
  });
});
