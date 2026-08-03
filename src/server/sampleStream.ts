import type { RawSpanEvent } from '../shared/contracts.js';
import { makeRawSpanEvent } from '../shared/contracts.js';

export interface SampleEvent {
  event: RawSpanEvent;
  ingestAfterMs: number;
  label: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSampleStream(baseTime: number): SampleEvent[] {
  const rand = mulberry32(20260803);
  const events: SampleEvent[] = [];

  const services = ['gateway', 'auth', 'orders', 'payments', 'inventory', 'notifications'];

  const trace1 = 'trace-incident-0001';
  const trace2 = 'trace-background-0002';
  const trace3 = 'trace-checkout-0003';

  function span(
    traceId: string,
    spanId: string,
    parentSpanId: string | null,
    service: string,
    operation: string,
    revision: number,
    eventOffsetMs: number,
    status: 'ok' | 'error' = 'ok',
    errorMessage: string | null = null,
  ): RawSpanEvent {
    return makeRawSpanEvent({
      traceId,
      spanId,
      parentSpanId,
      revision,
      eventTime: baseTime + eventOffsetMs,
      service,
      operation,
      status,
      errorMessage,
      attributes: {
        'deployment.env': 'prod',
        'sample.service': service,
        'sample.operation': operation,
      },
    });
  }

  function add(
    event: RawSpanEvent,
    ingestAfterMs: number,
    label: string,
  ): void {
    events.push({ event, ingestAfterMs, label });
  }

  // Trace 1: incident checkout. gateway -> auth -> orders -> payments -> inventory
  // payments initially reported OK (rev 1), then corrected to ERROR (rev 2) after investigation.
  add(span(trace1, 's1', null, 'gateway', 'POST /checkout', 1, 0), 50, 'gateway root');
  add(span(trace1, 's2', 's1', 'auth', 'verifyToken', 1, 20), 120, 'auth verify');
  add(span(trace1, 's3', 's1', 'orders', 'createOrder', 1, 80), 200, 'orders create');

  // payments rev1: OK (optimistic report, arrives early)
  add(span(trace1, 's4', 's3', 'payments', 'chargeCard', 1, 150, 'ok'), 260, 'payments rev1 OK');

  add(span(trace1, 's5', 's3', 'inventory', 'reserveStock', 1, 200), 1500, 'inventory LATE (reconnect burst)');

  // notifications child of gateway
  add(span(trace1, 's6', 's1', 'notifications', 'sendReceipt', 1, 300, 'ok'), 1600, 'notifications LATE');

  // payments rev2: ERROR correction, arrives much later (revision supersedes rev1)
  add(
    span(trace1, 's4', 's3', 'payments', 'chargeCard', 2, 150, 'error', 'Card declined: issuer timeout (reconciled)'),
    2400,
    'payments rev2 ERROR correction',
  );

  // Duplicate of auth span (same revision, re-delivered by collector after reconnect)
  add(span(trace1, 's2', 's1', 'auth', 'verifyToken', 1, 20), 2600, 'auth DUPLICATE redelivery');

  // Trace 2: healthy background job, all in order, no revisions
  add(span(trace2, 'b1', null, 'gateway', 'CRON hourly', 1, 400), 500, 'bg root');
  add(span(trace2, 'b2', 'b1', 'notifications', 'digest', 1, 450), 580, 'bg digest');
  add(span(trace2, 'b3', 'b2', 'auth', 'refreshToken', 1, 470), 650, 'bg refresh');

  // Trace 3: another checkout, payments error immediately (no revision), inventory ok
  add(span(trace3, 'c1', null, 'gateway', 'POST /checkout', 1, 700), 720, 'checkout2 root');
  add(span(trace3, 'c2', 'c1', 'orders', 'createOrder', 1, 750), 800, 'checkout2 orders');
  add(
    span(trace3, 'c3', 'c2', 'payments', 'chargeCard', 1, 800, 'error', 'Insufficient funds'),
    880,
    'checkout2 payments ERROR',
  );
  add(span(trace3, 'c4', 'c2', 'inventory', 'releaseStock', 1, 850), 950, 'checkout2 inventory release');

  // Introduce some randomised out-of-order jitter on additional spans to exercise determinism
  for (let i = 0; i < 6; i++) {
    const svc = services[i % services.length]!;
    const t = i % 2 === 0 ? trace2 : trace3;
    const sid = `x${i}`;
    const parent = t === trace2 ? 'b1' : 'c1';
    const offset = 1000 + i * 60;
    const event = span(t, sid, parent, svc, `poll-${i}`, 1, offset, 'ok');
    const ingestDelay = 3000 + Math.floor(rand() * 1200);
    add(event, ingestDelay, `jitter span ${i}`);
  }

  events.sort((a, b) => a.ingestAfterMs - b.ingestAfterMs);
  return events;
}
