import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/server/ledger';
import { buildScript } from '../../src/sample/script';
import { projectView, computeBounds } from '../../src/shared/projection';
import type { ReplayCursor } from '../../src/shared/contract';

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  dirs.push(dir);
  return join(dir, 'ledger.sqlite');
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('Ledger: append-only + monotonic ingestSequence', () => {
  it('assigns strictly increasing ingestSequence and ignores duplicates', () => {
    const ledger = new Ledger(tmpDb());
    const events = buildScript(1).map((s) => s.event);
    const { accepted, duplicates } = ledger.appendBatch(events, Date.now());
    // Re-send the whole batch: every one is now a duplicate.
    const again = ledger.appendBatch(events, Date.now());

    const seqs = accepted.map((r) => r.ingestSequence);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(again.accepted).toHaveLength(0);
    expect(again.duplicates).toBe(events.length);
    expect(duplicates).toBeGreaterThanOrEqual(0);
    ledger.close();
  });

  it('retains every revision in the ledger', () => {
    const ledger = new Ledger(tmpDb());
    ledger.appendBatch(buildScript(1).map((s) => s.event), Date.now());
    const all = ledger.readAll();
    const paymentsRevisions = all
      .filter((r) => r.spanId === 'payments')
      .map((r) => r.revision)
      .sort();
    expect(paymentsRevisions).toContain(0);
    expect(paymentsRevisions).toContain(1);
    ledger.close();
  });
});

describe('Ledger: restart recovery from SQLite', () => {
  it('recovers full state after reopen without re-ingesting', () => {
    const path = tmpDb();
    const ledger = new Ledger(path);
    ledger.appendBatch(buildScript(1).map((s) => s.event), Date.now());
    const boundsBefore = ledger.bounds();
    const countBefore = ledger.count();
    ledger.close();

    // Reopen: simulates process restart.
    const reopened = new Ledger(path);
    expect(reopened.count()).toBe(countBefore);
    expect(reopened.bounds()).toEqual(boundsBefore);

    // A new append continues the monotonic sequence past the recovered max.
    const next = reopened.append(
      {
        contractVersion: 1,
        traceId: 'T-after',
        spanId: 'after',
        parentSpanId: null,
        service: 'svc',
        operation: 'op',
        revision: 0,
        eventTimeMs: boundsBefore.maxEventTimeMs + 1,
        durationMs: 1,
        status: 'ok',
        revisionReason: null,
        errorKind: null,
      },
      Date.now(),
    );
    expect(next).not.toBeNull();
    expect(next!.ingestSequence).toBeGreaterThan(boundsBefore.maxIngestSequence);
    reopened.close();
  });
});

describe('Ledger + projection: reproducible view at a cursor', () => {
  it('rebuilds the same view regardless of restart', () => {
    const path = tmpDb();
    const ledger = new Ledger(path);
    ledger.appendBatch(buildScript(1).map((s) => s.event), Date.now());
    const bounds = ledger.bounds();
    const cursor: ReplayCursor = {
      eventTimeMs: bounds.maxEventTimeMs,
      ingestSequence: bounds.maxIngestSequence,
    };
    const before = projectView(ledger.readUpToIngest(cursor.ingestSequence), cursor);
    ledger.close();

    const reopened = new Ledger(path);
    const after = projectView(reopened.readUpToIngest(cursor.ingestSequence), cursor);
    reopened.close();

    expect(JSON.stringify(after)).toEqual(JSON.stringify(before));
    // Payments is corrected to error at the final cursor.
    const payments = after.spans.find((s) => s.spanId === 'payments')!;
    expect(payments.status).toBe('error');
    expect(payments.revision).toBe(1);
  });

  it('scrubbing ingestSequence backward hides the correction deterministically', () => {
    const ledger = new Ledger(tmpDb());
    const events = buildScript(1).map((s) => s.event);
    const accepted = ledger.appendBatch(events, Date.now()).accepted;
    // Find the ingestSequence at which payments revision 1 arrived.
    const paymentsR1 = accepted.find((r) => r.spanId === 'payments' && r.revision === 1)!;
    const justBefore = paymentsR1.ingestSequence - 1;
    const bounds = ledger.bounds();

    const before = projectView(ledger.readAll(), {
      eventTimeMs: bounds.maxEventTimeMs,
      ingestSequence: justBefore,
    });
    const payments = before.spans.find((s) => s.spanId === 'payments');
    if (payments) {
      expect(payments.revision).toBe(0);
      expect(payments.versionReason.supersededLater).toBe(true);
    }
    ledger.close();
  });
});

describe('computeBounds matches ledger bounds', () => {
  it('agrees with SQL aggregates', () => {
    const ledger = new Ledger(tmpDb());
    ledger.appendBatch(buildScript(7).map((s) => s.event), Date.now());
    const fromRecords = computeBounds(ledger.readAll());
    expect(fromRecords).toEqual(ledger.bounds());
    ledger.close();
  });
});
