import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app';
import { buildScript } from '../../src/sample/script';
import { toNdjson } from '../../src/shared/ndjson';
import { ProjectionView, IngestResult, SnapshotView, SnapshotComparison, SessionState } from '../../src/shared/contract';

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

describe('HTTP app: snapshots + compare', () => {
  async function seedApp(dbPath: string) {
    const { app } = buildApp({ dbPath });
    cleanups.push(() => app.close());
    await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: toNdjson(buildScript(1).map((s) => s.event)),
    });
    return app;
  }

  it('seals a snapshot over HTTP and rejects later rewrites of it', async () => {
    const app = await seedApp(tmpDb());
    const bounds = (await app.inject({ method: 'GET', url: '/api/bounds' })).json() as {
      bounds: { maxEventTimeMs: number; maxIngestSequence: number };
    };
    const sealRes = await app.inject({
      method: 'POST',
      url: '/api/snapshots',
      headers: { 'content-type': 'application/json' },
      payload: {
        label: 'A',
        note: 'investigating payments',
        cursor: { eventTimeMs: bounds.bounds.maxEventTimeMs, ingestSequence: bounds.bounds.maxIngestSequence },
      },
    });
    expect(sealRes.statusCode).toBe(201);
    const sealed = SnapshotView.parse(sealRes.json());
    expect(sealed.snapshot.provenance.digest).toMatch(/^[0-9a-f]{64}$/);

    // A late event arrives after sealing.
    await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: toNdjson([
        {
          contractVersion: 1,
          traceId: 'trace-late',
          spanId: 'late-http',
          parentSpanId: null,
          service: 'late',
          operation: 'op',
          revision: 0,
          eventTimeMs: bounds.bounds.maxEventTimeMs + 10,
          durationMs: 1,
          status: 'error',
          revisionReason: null,
          errorKind: 'Late',
        },
      ]),
    });

    // The sealed snapshot's digest is unchanged and still verifies.
    const verify = await app.inject({ method: 'GET', url: `/api/snapshots/${sealed.snapshot.id}/verify` });
    const vbody = verify.json() as { valid: boolean; digest: string };
    expect(vbody.valid).toBe(true);
    expect(vbody.digest).toBe(sealed.snapshot.provenance.digest);

    const reloaded = SnapshotView.parse((await app.inject({ method: 'GET', url: `/api/snapshots/${sealed.snapshot.id}` })).json());
    expect(reloaded.view.spans.find((s) => s.spanId === 'late-http')).toBeUndefined();
  });

  it('compares two sealed snapshots deterministically (A -> B)', async () => {
    const app = await seedApp(tmpDb());
    const bounds = (await app.inject({ method: 'GET', url: '/api/bounds' })).json() as {
      bounds: { maxEventTimeMs: number; maxIngestSequence: number };
    };
    // A: only the first event known. B: everything known.
    const a = SnapshotView.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/snapshots',
          headers: { 'content-type': 'application/json' },
          payload: { label: 'A', note: null, cursor: { eventTimeMs: bounds.bounds.maxEventTimeMs, ingestSequence: 1 } },
        })
      ).json(),
    );
    const b = SnapshotView.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/snapshots',
          headers: { 'content-type': 'application/json' },
          payload: {
            label: 'B',
            note: null,
            cursor: { eventTimeMs: bounds.bounds.maxEventTimeMs, ingestSequence: bounds.bounds.maxIngestSequence },
          },
        })
      ).json(),
    );

    const cmpRes = await app.inject({ method: 'GET', url: `/api/compare?from=${a.snapshot.id}&to=${b.snapshot.id}` });
    const cmp = SnapshotComparison.parse(cmpRes.json());
    // Going from "only 1 record known" to "all known" must add spans.
    expect(cmp.summary.added).toBeGreaterThan(0);
    expect(cmp.from.id).toBe(a.snapshot.id);
    expect(cmp.to.id).toBe(b.snapshot.id);
  });

  it('persists sealed snapshots and their digests across a restart', async () => {
    const dbPath = tmpDb();
    const first = await seedApp(dbPath);
    const bounds = (await first.inject({ method: 'GET', url: '/api/bounds' })).json() as {
      bounds: { maxEventTimeMs: number; maxIngestSequence: number };
    };
    const sealed = SnapshotView.parse(
      (
        await first.inject({
          method: 'POST',
          url: '/api/snapshots',
          headers: { 'content-type': 'application/json' },
          payload: {
            label: 'A',
            note: 'survives restart',
            cursor: { eventTimeMs: bounds.bounds.maxEventTimeMs, ingestSequence: bounds.bounds.maxIngestSequence },
          },
        })
      ).json(),
    );
    await first.close();

    const second = buildApp({ dbPath });
    cleanups.push(() => second.app.close());
    const reloaded = SnapshotView.parse((await second.app.inject({ method: 'GET', url: `/api/snapshots/${sealed.snapshot.id}` })).json());
    expect(reloaded.snapshot.provenance.digest).toBe(sealed.snapshot.provenance.digest);
    expect(reloaded.snapshot.note).toBe('survives restart');
  });
});

describe('HTTP app: collaboration sessions over the wire', () => {
  async function seedAnchorSession(dbPath: string) {
    const { app } = buildApp({ dbPath });
    cleanups.push(() => app.close());
    await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: toNdjson(buildScript(1).map((s) => s.event)),
    });
    const bounds = (await app.inject({ method: 'GET', url: '/api/bounds' })).json() as {
      bounds: { maxEventTimeMs: number; maxIngestSequence: number };
    };
    const sealed = SnapshotView.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/snapshots',
          headers: { 'content-type': 'application/json' },
          payload: {
            label: 'A',
            note: null,
            cursor: { eventTimeMs: bounds.bounds.maxEventTimeMs, ingestSequence: bounds.bounds.maxIngestSequence },
          },
        })
      ).json(),
    );
    const session = SessionState.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { 'content-type': 'application/json' },
          payload: { label: 'handoff', anchorSnapshotId: sealed.snapshot.id, anchorDigest: sealed.snapshot.provenance.digest },
        })
      ).json(),
    );
    return { app, sealed, session, cursor: { eventTimeMs: bounds.bounds.maxEventTimeMs, ingestSequence: bounds.bounds.maxIngestSequence } };
  }

  it('only the lease holder can seal under a session; others are fenced (409)', async () => {
    const { app, session, cursor } = await seedAnchorSession(tmpDb());

    // teamA acquires the lease.
    const leased = SessionState.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/api/sessions/${session.session.id}/lease`,
          headers: { 'content-type': 'application/json' },
          payload: { holder: 'teamA' },
        })
      ).json(),
    );
    const tokenA = leased.lease!.fencingToken;

    // teamA (valid holder) can seal.
    const okSeal = await app.inject({
      method: 'POST',
      url: '/api/snapshots',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'B', note: 'by owner', cursor, writer: { sessionId: session.session.id, holder: 'teamA', fencingToken: tokenA } },
    });
    expect(okSeal.statusCode).toBe(201);

    // teamB, without the lease, is fenced out.
    const badSeal = await app.inject({
      method: 'POST',
      url: '/api/snapshots',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'C', note: 'intruder', cursor, writer: { sessionId: session.session.id, holder: 'teamB', fencingToken: 999 } },
    });
    expect(badSeal.statusCode).toBe(409);
  });

  it('a stale token cannot advance the shared cursor after takeover', async () => {
    const { app, session } = await seedAnchorSession(tmpDb());
    // teamA acquires with a short TTL.
    const a = SessionState.parse(
      (await app.inject({ method: 'POST', url: `/api/sessions/${session.session.id}/lease`, headers: { 'content-type': 'application/json' }, payload: { holder: 'teamA', ttlMs: 1 } })).json(),
    );
    const tokenA = a.lease!.fencingToken;
    // teamB takes over (A's tiny TTL has elapsed by wall clock).
    await new Promise((r) => setTimeout(r, 5));
    const b = SessionState.parse(
      (await app.inject({ method: 'POST', url: `/api/sessions/${session.session.id}/lease`, headers: { 'content-type': 'application/json' }, payload: { holder: 'teamB' } })).json(),
    );
    const tokenB = b.lease!.fencingToken;
    expect(tokenB).toBeGreaterThan(tokenA);

    // A's late cursor advance is rejected.
    const stale = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.session.id}/cursor`,
      headers: { 'content-type': 'application/json' },
      payload: { holder: 'teamA', fencingToken: tokenA, cursor: { eventTimeMs: 1, ingestSequence: 1 } },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('merges concurrent notes deterministically and persists across restart', async () => {
    const dbPath = tmpDb();
    const { app, session } = await seedAnchorSession(dbPath);
    const sid = session.session.id;
    const post = (n: { id: string; author: string; lamport: number; body: string }) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sid}/notes`,
        headers: { 'content-type': 'application/json' },
        payload: { note: { ...n, createdAtMs: 0 } },
      });
    await post({ id: 'nb', author: 'teamB', lamport: 2, body: 'B' });
    await post({ id: 'na', author: 'teamA', lamport: 1, body: 'A' });
    const merged = SessionState.parse((await post({ id: 'nc', author: 'teamA', lamport: 2, body: 'C' })).json());
    expect(merged.notes.map((n) => n.id)).toEqual(['na', 'nc', 'nb']);
    await app.close();

    const second = buildApp({ dbPath });
    cleanups.push(() => second.app.close());
    const reloaded = SessionState.parse((await second.app.inject({ method: 'GET', url: `/api/sessions/${sid}` })).json());
    expect(reloaded.notes.map((n) => n.id)).toEqual(['na', 'nc', 'nb']);
  });
});
