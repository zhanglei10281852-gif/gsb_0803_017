import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '../../src/server/ledgerStore';
import { ReplayService } from '../../src/server/replayService';
import { SpanEvent } from '../../src/shared/contracts';

function mkEvent(spanId: string, revision: number, eventTime: number, status: 'ok' | 'error' = 'ok'): SpanEvent {
  return {
    contractVersion: 1,
    traceId: 't-1',
    spanId,
    parentSpanId: null,
    service: spanId === 'gw' ? 'gateway' : 'payment',
    operation: 'op',
    kind: 'server',
    status,
    startTime: eventTime,
    endTime: eventTime + 10,
    revision,
    eventTime,
    attributes: {}
  };
}

describe('snapshot storage across restart', () => {
  let dir: string;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'));
    store = new LedgerStore(join(dir, 'replay.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sealed snapshot digest is identical after restart and survives late arrivals', () => {
    const service1 = new ReplayService(store);
    service1.ingest([mkEvent('gw', 1, 100), mkEvent('pay', 1, 200)]);
    const cursorA = service1.liveCursor();
    service1.ingest([mkEvent('pay', 2, 300, 'error')]);
    const cursorB = service1.liveCursor();

    const snap1 = service1.createSnapshot({
      labelA: 'A',
      labelB: 'B',
      cursorA,
      cursorB,
      notes: 'initial'
    });

    service1.ingest([mkEvent('gw', 2, 400, 'error')]);

    service1.close();

    const reopenedStore = new LedgerStore(join(dir, 'replay.db'));
    const service2 = new ReplayService(reopenedStore);
    const loaded = service2.getSnapshot(snap1.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.digestA.recordsDigest).toBe(snap1.digestA.recordsDigest);
    expect(loaded!.digestB.recordsDigest).toBe(snap1.digestB.recordsDigest);
    expect(loaded!.diff.summary.statusChangedCount).toBe(snap1.diff.summary.statusChangedCount);
    expect(loaded!.diff.added.map((s) => s.spanId)).toEqual(snap1.diff.added.map((s) => s.spanId));

    const updated = service2.updateSnapshotNotes(snap1.id, 'updated notes after restart');
    expect(updated!.notes).toBe('updated notes after restart');
    expect(updated!.digestA.recordsDigest).toBe(snap1.digestA.recordsDigest);
    expect(updated!.diff).toEqual(snap1.diff);

    const newSnap = service2.createSnapshot({
      labelA: 'A2',
      labelB: 'B2',
      cursorA,
      cursorB: service2.liveCursor(),
      notes: 'later'
    });
    expect(newSnap.id).not.toBe(snap1.id);

    const allSnapshots = service2.listSnapshots();
    expect(allSnapshots).toHaveLength(2);
    const originalStill = allSnapshots.find((s) => s.id === snap1.id)!;
    expect(originalStill.notes).toBe('updated notes after restart');
    expect(originalStill.digestB.recordsDigest).toBe(snap1.digestB.recordsDigest);

    reopenedStore.close();
  });
});
