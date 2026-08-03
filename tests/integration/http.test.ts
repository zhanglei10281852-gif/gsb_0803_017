import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app';
import { buildScript } from '../../src/sample/script';
import { toNdjson } from '../../src/shared/ndjson';
import { ProjectionView, IngestResult } from '../../src/shared/contract';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'ledger.sqlite');
}

describe('HTTP app: ingest + view + restart', () => {
  it('ingests NDJSON over HTTP and serves a reproducible view', async () => {
    const dbPath = tmpDb();
    const { app } = buildApp({ dbPath });
    cleanups.push(() => app.close());

    const events = buildScript(1).map((s) => s.event);
    const ingest = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: toNdjson(events),
    });
    expect([200, 207]).toContain(ingest.statusCode);
    const result = IngestResult.parse(ingest.json());
    expect(result.accepted).toBeGreaterThan(0);
    expect(result.maxIngestSequence).toBe(result.accepted);

    // Duplicate re-post yields zero accepted.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: toNdjson(events),
    });
    expect(IngestResult.parse(dup.json()).accepted).toBe(0);

    const boundsRes = await app.inject({ method: 'GET', url: '/api/bounds' });
    const bounds = (boundsRes.json() as { bounds: { maxEventTimeMs: number; maxIngestSequence: number } }).bounds;

    const viewRes = await app.inject({
      method: 'GET',
      url: `/api/view?eventTimeMs=${bounds.maxEventTimeMs}&ingestSequence=${bounds.maxIngestSequence}`,
    });
    const view = ProjectionView.parse(viewRes.json());
    const payments = view.spans.find((s) => s.spanId === 'payments')!;
    expect(payments.status).toBe('error');
    expect(payments.revision).toBe(1);
  });

  it('persists across a simulated restart (reopen same db)', async () => {
    const dbPath = tmpDb();
    const first = buildApp({ dbPath });
    const events = buildScript(1).map((s) => s.event);
    const ingestRes = await first.app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: toNdjson(events),
    });
    const accepted = IngestResult.parse(ingestRes.json()).accepted;
    const beforeBounds = (await first.app.inject({ method: 'GET', url: '/api/bounds' })).json();
    await first.app.close();

    const second = buildApp({ dbPath });
    cleanups.push(() => second.app.close());
    const afterBounds = (await second.app.inject({ method: 'GET', url: '/api/bounds' })).json();
    expect(afterBounds).toEqual(beforeBounds);

    const health = await second.app.inject({ method: 'GET', url: '/api/health' });
    // The script contains an intentional duplicate, so the durable count equals
    // the number of accepted (unique) records, not the raw line count.
    expect((health.json() as { count: number }).count).toBe(accepted);
  });

  it('handles out-of-order and partial-invalid batches', async () => {
    const dbPath = tmpDb();
    const { app } = buildApp({ dbPath });
    cleanups.push(() => app.close());

    const events = buildScript(1).map((s) => s.event);
    // Deliver in reversed order with a garbage line in the middle.
    const body = `${toNdjson(events.slice().reverse()).trim()}\ngarbage-line`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: body,
    });
    expect(res.statusCode).toBe(207); // partial: has errors
    const bounds = (await app.inject({ method: 'GET', url: '/api/bounds' })).json() as {
      bounds: { maxEventTimeMs: number; maxIngestSequence: number };
    };
    const view = ProjectionView.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/view?eventTimeMs=${bounds.bounds.maxEventTimeMs}&ingestSequence=${bounds.bounds.maxIngestSequence}`,
        })
      ).json(),
    );
    // Despite reversed delivery, the resolved payments version is still r1/error.
    const payments = view.spans.find((s) => s.spanId === 'payments')!;
    expect(payments.revision).toBe(1);
    expect(payments.status).toBe('error');
  });
});
