import { CONTRACT_VERSION, type SpanEventInput } from '../shared/contract';

/**
 * A tiny deterministic PRNG (mulberry32) so the sample stream is identical for
 * a given seed. This is what makes "confusing" incidents reproducible for
 * on-call rehearsals and for the automated tests.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A wire event paired with the "delivery ordinal" describing when it should be
 * delivered relative to the natural order. We deliberately shuffle, duplicate
 * and re-revise these so ingestion sees late/out-of-order/duplicate/reconnect
 * conditions, while eventTime encodes the true incident timeline.
 */
export interface ScriptedEvent {
  event: SpanEventInput;
  /** Delivery bucket index; lower buckets are POSTed first (after shuffle). */
  deliverBucket: number;
  /** Marks records that are exact duplicates re-sent later (idempotency). */
  isDuplicate: boolean;
  /** Marks a higher-revision correction of an earlier span. */
  isRevision: boolean;
}

function span(partial: Omit<SpanEventInput, 'contractVersion'>): SpanEventInput {
  return { contractVersion: CONTRACT_VERSION, ...partial };
}

/**
 * Build a deterministic incident script. It models a checkout request fanning
 * out across services, an error erupting in `payments`, a late-arriving child
 * span, a corrected revision that reclassifies the root cause, plus duplicates.
 */
export function buildScript(seed = 1): ScriptedEvent[] {
  const base = 1_700_000_000_000; // fixed epoch so eventTimes are stable
  const t = (offset: number): number => base + offset;
  const raw: ScriptedEvent[] = [];

  const add = (
    e: Omit<SpanEventInput, 'contractVersion'>,
    opts: { bucket: number; duplicate?: boolean; revision?: boolean } = { bucket: 0 },
  ): void => {
    raw.push({
      event: span(e),
      deliverBucket: opts.bucket,
      isDuplicate: opts.duplicate ?? false,
      isRevision: opts.revision ?? false,
    });
  };

  const trace = 'trace-checkout-001';

  // Root request.
  add({
    traceId: trace, spanId: 'gateway', parentSpanId: null,
    service: 'api-gateway', operation: 'POST /checkout', revision: 0,
    eventTimeMs: t(0), durationMs: 420, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 0 });

  // Gateway -> orders.
  add({
    traceId: trace, spanId: 'orders', parentSpanId: 'gateway',
    service: 'orders', operation: 'createOrder', revision: 0,
    eventTimeMs: t(20), durationMs: 380, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 1 });

  // orders -> inventory (ok).
  add({
    traceId: trace, spanId: 'inventory', parentSpanId: 'orders',
    service: 'inventory', operation: 'reserveStock', revision: 0,
    eventTimeMs: t(40), durationMs: 90, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 2 });

  // orders -> payments (initially reported OK, out of order arrival).
  add({
    traceId: trace, spanId: 'payments', parentSpanId: 'orders',
    service: 'payments', operation: 'charge', revision: 0,
    eventTimeMs: t(60), durationMs: 250, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 3 });

  // payments -> bank (LATE span; delivered in a much later bucket).
  add({
    traceId: trace, spanId: 'bank', parentSpanId: 'payments',
    service: 'bank-connector', operation: 'authorize', revision: 0,
    eventTimeMs: t(80), durationMs: 210, status: 'error', revisionReason: null,
    errorKind: 'UpstreamTimeout',
  }, { bucket: 7 });

  // REVISION: payments corrected to error once the failure was understood.
  add({
    traceId: trace, spanId: 'payments', parentSpanId: 'orders',
    service: 'payments', operation: 'charge', revision: 1,
    eventTimeMs: t(60), durationMs: 250, status: 'error',
    revisionReason: 'Reclassified as failure after bank authorize timeout was correlated',
    errorKind: 'DownstreamFailure',
  }, { bucket: 8, revision: true });

  // DUPLICATE re-send of the gateway root (reconnect replays the buffer).
  add({
    traceId: trace, spanId: 'gateway', parentSpanId: null,
    service: 'api-gateway', operation: 'POST /checkout', revision: 0,
    eventTimeMs: t(0), durationMs: 420, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 5, duplicate: true });

  // A second, independent healthy trace to give the topology some breadth.
  const trace2 = 'trace-catalog-002';
  add({
    traceId: trace2, spanId: 'g2', parentSpanId: null,
    service: 'api-gateway', operation: 'GET /catalog', revision: 0,
    eventTimeMs: t(10), durationMs: 120, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 1 });
  add({
    traceId: trace2, spanId: 'search', parentSpanId: 'g2',
    service: 'search', operation: 'query', revision: 0,
    eventTimeMs: t(25), durationMs: 70, status: 'ok', revisionReason: null, errorKind: null,
  }, { bucket: 4 });

  // Deterministic shuffle within-and-across buckets using the seeded PRNG so we
  // exercise out-of-order ingestion while remaining reproducible.
  const rnd = mulberry32(seed);
  const shuffled = raw
    .map((e) => ({ e, k: rnd() }))
    .sort((a, b) => (a.e.deliverBucket - b.e.deliverBucket) || (a.k - b.k))
    .map((x) => x.e);
  return shuffled;
}

/** Split the script into "connection sessions" to simulate reconnects. */
export function toSessions(script: ScriptedEvent[], sessions = 3): ScriptedEvent[][] {
  const out: ScriptedEvent[][] = Array.from({ length: sessions }, () => []);
  script.forEach((ev, i) => {
    const idx = i % sessions;
    out[idx]!.push(ev);
  });
  return out;
}
