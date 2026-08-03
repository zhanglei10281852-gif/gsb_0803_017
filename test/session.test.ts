import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore } from '../src/server/db.js';
import { ReplayEngine, FencingError } from '../src/server/replay.js';
import { makeRawSpanEvent } from '../src/shared/contracts.js';
import { tempDbPath, cleanupPath } from './util.js';

const paths: string[] = [];

function newEngine(label: string, clock?: () => number): ReplayEngine {
  const p = tempDbPath(label);
  paths.push(p);
  return new ReplayEngine(new LedgerStore(p), clock);
}

function makeClock(start = 1000): { now: () => number; advance: (ms: number) => number } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; return t; },
  };
}

afterEach(() => {
  for (const p of paths) cleanupPath(p);
  paths.length = 0;
});

describe('lease fencing', () => {
  test('first client acquires with fencing token 1', () => {
    const clock = makeClock();
    const engine = newEngine('acquire');
    const svc = engine.getSession();
    const result = svc.acquire('client-1', 'Alice', 30000);
    assert.equal(result.ok, true);
    assert.equal(result.lease!.fencingToken, 1);
    assert.equal(result.lease!.holderClientId, 'client-1');
    engine.close();
  });

  test('second client cannot acquire while lease is held', () => {
    const clock = makeClock();
    const engine = newEngine('held');
    const svc = engine.getSession();
    svc.acquire('client-1', 'Alice', 30000);
    const result = svc.acquire('client-2', 'Bob', 30000);
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, 'LEASE_HELD');
    assert.equal(svc.getLease()!.holderClientId, 'client-1');
    engine.close();
  });

  test('second client can take over after lease expires; fencing token increments', () => {
    const clock = makeClock(1000);
    const engine = newEngine('takeover', clock.now);
    const svc = engine.getSession();
    const a = svc.acquire('client-1', 'Alice', 1000);
    assert.equal(a.lease!.fencingToken, 1);
    clock.advance(1001);
    const b = svc.acquire('client-2', 'Bob', 1000);
    assert.equal(b.ok, true);
    assert.equal(b.lease!.fencingToken, 2, 'fencing token must increment on takeover');
    assert.equal(svc.getLease()!.holderClientId, 'client-2');
    engine.close();
  });

  test('stale holder with old fencing token cannot advance cursor after takeover', () => {
    const clock = makeClock(1000);
    const engine = newEngine('stale', clock.now);
    const svc = engine.getSession();
    svc.acquire('client-1', 'Alice', 1000);
    clock.advance(1001);
    svc.acquire('client-2', 'Bob', 5000);

    const stale = svc.advanceCursor('client-1', 1, { eventTime: 9999, ingestSequence: 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.error!.code, 'STALE_FENCING', 'old fencing token must be rejected');

    const fresh = svc.advanceCursor('client-2', 2, { eventTime: 9999, ingestSequence: 5 });
    assert.equal(fresh.ok, true);
    assert.equal(svc.getSharedCursor().ingestSequence, 5);
    engine.close();
  });

  test('renew with wrong fencing token is rejected', () => {
    const clock = makeClock();
    const engine = newEngine('renew-stale');
    const svc = engine.getSession();
    svc.acquire('client-1', 'Alice', 30000);
    const result = svc.renew('client-1', 999);
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, 'STALE_FENCING');
    engine.close();
  });

  test('release clears the lease so another client can acquire', () => {
    const clock = makeClock();
    const engine = newEngine('release');
    const svc = engine.getSession();
    const a = svc.acquire('client-1', 'Alice', 30000);
    assert.equal(svc.release('client-1', a.lease!.fencingToken), true);
    assert.equal(svc.getLease(), null);
    const b = svc.acquire('client-2', 'Bob', 30000);
    assert.equal(b.ok, true);
    assert.equal(b.lease!.fencingToken, 2);
    engine.close();
  });
});

describe('fencing for snapshot sealing', () => {
  test('sealing without fencing is allowed when no lease is active', () => {
    const engine = newEngine('seal-nolease');
    engine.ingest(makeRawSpanEvent({
      traceId: 't', spanId: 's', parentSpanId: null, revision: 1,
      eventTime: 1000, service: 'svc', operation: 'op', status: 'ok',
      errorMessage: null, attributes: {},
    }));
    const snap = engine.createSnapshot('A', 'test', { eventTime: 99999, ingestSequence: 99999 }, '');
    assert.ok(snap.id);
    engine.close();
  });

  test('sealing is rejected for non-holder when lease active', () => {
    const engine = newEngine('seal-reject');
    const svc = engine.getSession();
    svc.acquire('leader', 'Alice', 30000);
    assert.throws(() => {
      engine.createSnapshot('A', 'test', { eventTime: 99999, ingestSequence: 99999 }, '', { clientId: 'intruder', token: 1 });
    }, (e: unknown) => e instanceof FencingError && (e as FencingError).leaseError.code === 'NOT_LEADER');
    engine.close();
  });

  test('stale fencing token (pre-takeover) is rejected when sealing', () => {
    const clock = makeClock(1000);
    const engine = newEngine('seal-stale', clock.now);
    const svc = engine.getSession();
    svc.acquire('old-leader', 'Alice', 1000);
    clock.advance(1001);
    svc.acquire('new-leader', 'Bob', 5000);
    assert.throws(() => {
      engine.createSnapshot('A', 'test', { eventTime: 99999, ingestSequence: 99999 }, '', { clientId: 'old-leader', token: 1 });
    }, (e: unknown) => e instanceof FencingError && (e as FencingError).leaseError.code === 'STALE_FENCING');
    engine.close();
  });

  test('holder can seal with valid fencing token', () => {
    const engine = newEngine('seal-ok');
    const svc = engine.getSession();
    const lease = svc.acquire('leader', 'Alice', 30000);
    const snap = engine.createSnapshot('A', 'test', { eventTime: 99999, ingestSequence: 99999 }, '', {
      clientId: 'leader', token: lease.lease!.fencingToken,
    });
    assert.ok(snap.id);
    engine.close();
  });
});

describe('deterministic note merging (CRDT)', () => {
  test('notes are merged by (clientId, clientSeq) regardless of arrival order', () => {
    const engine = newEngine('notes-crdt');
    const svc = engine.getSession();

    svc.addNote({ clientId: 'c1', clientSeq: 2, authorName: 'A', text: 'second', snapshotId: null, createdAt: 2000 });
    svc.addNote({ clientId: 'c1', clientSeq: 1, authorName: 'A', text: 'first', snapshotId: null, createdAt: 1000 });
    svc.addNote({ clientId: 'c2', clientSeq: 1, authorName: 'B', text: 'from B', snapshotId: null, createdAt: 1500 });

    const notes = svc.getNotes();
    assert.equal(notes.length, 3);
    assert.deepEqual(notes.map((n) => n.text), ['first', 'from B', 'second'], 'must be sorted by createdAt');
  });

  test('duplicate note with same (clientId, clientSeq) is idempotent', () => {
    const engine = newEngine('notes-idempotent');
    const svc = engine.getSession();
    svc.addNote({ clientId: 'c1', clientSeq: 1, authorName: 'A', text: 'original', snapshotId: null, createdAt: 1000 });
    const { isNew } = svc.addNote({ clientId: 'c1', clientSeq: 1, authorName: 'A', text: 'overwrite?', snapshotId: null, createdAt: 1000 });
    assert.equal(isNew, false, 'duplicate must not be added again');
    assert.equal(svc.getNotes().length, 1);
    assert.equal(svc.getNotes()[0]!.text, 'original', 'first writer wins, no last-writer-wins');
  });

  test('notes persist across engine restart', () => {
    const p = tempDbPath('notes-persist');
    paths.push(p);
    const e1 = new ReplayEngine(new LedgerStore(p));
    e1.getSession().addNote({ clientId: 'c1', clientSeq: 1, authorName: 'A', text: 'handover note', snapshotId: null, createdAt: 1000 });
    e1.close();

    const e2 = new ReplayEngine(new LedgerStore(p));
    const notes = e2.getSession().getNotes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.text, 'handover note');
    e2.close();
  });

  test('lease persists across restart and fencing token is preserved', () => {
    const p = tempDbPath('lease-persist');
    paths.push(p);
    const e1 = new ReplayEngine(new LedgerStore(p));
    const lease = e1.getSession().acquire('c1', 'Alice', 300000);
    assert.equal(lease.lease!.fencingToken, 1);
    e1.close();

    const e2 = new ReplayEngine(new LedgerStore(p));
    const restored = e2.getSession().getLease();
    assert.ok(restored, 'lease must survive restart');
    assert.equal(restored!.fencingToken, 1, 'fencing token must be preserved');
    assert.equal(restored!.holderClientId, 'c1');
    e2.close();
  });
});
