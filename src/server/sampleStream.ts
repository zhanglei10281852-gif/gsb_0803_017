import { CONTRACT_VERSION, SpanEvent } from '../shared/contracts';

const BASE_TIME = 1_700_000_000_000;
const SECOND = 1000;

export interface SampleBatch {
  readonly label: string;
  readonly reconnect?: boolean;
  readonly events: readonly SpanEvent[];
}

function span(input: Omit<SpanEvent, 'contractVersion'>): SpanEvent {
  return { contractVersion: CONTRACT_VERSION, ...input };
}

export function buildSampleStream(): readonly SampleBatch[] {
  const traceA = 'trace-incident-0001';
  const traceB = 'trace-reconnect-0002';

  const t = (offsetSeconds: number): number => BASE_TIME + offsetSeconds * SECOND;

  const batches: SampleBatch[] = [
    {
      label: 'gateway starts request',
      events: [
        span({
          traceId: traceA,
          spanId: 'gw-1',
          parentSpanId: null,
          service: 'gateway',
          operation: 'POST /checkout',
          kind: 'server',
          status: 'ok',
          startTime: t(0),
          endTime: t(9),
          revision: 1,
          eventTime: t(0.1),
          attributes: { region: 'cn-north', route: '/checkout' }
        })
      ]
    },
    {
      label: 'auth call arrives out of order',
      events: [
        span({
          traceId: traceA,
          spanId: 'auth-1',
          parentSpanId: 'gw-1',
          service: 'auth',
          operation: 'validateToken',
          kind: 'server',
          status: 'ok',
          startTime: t(0.2),
          endTime: t(0.8),
          revision: 1,
          eventTime: t(1.2),
          attributes: { userId: 'u-42' }
        })
      ]
    },
    {
      label: 'payment starts',
      events: [
        span({
          traceId: traceA,
          spanId: 'pay-1',
          parentSpanId: 'gw-1',
          service: 'payment',
          operation: 'charge',
          kind: 'client',
          status: 'ok',
          startTime: t(1),
          endTime: t(5),
          revision: 1,
          eventTime: t(1.1),
          attributes: { amount: 199.0 }
        })
      ]
    },
    {
      label: 'duplicate payment span resent by collector',
      events: [
        span({
          traceId: traceA,
          spanId: 'pay-1',
          parentSpanId: 'gw-1',
          service: 'payment',
          operation: 'charge',
          kind: 'client',
          status: 'ok',
          startTime: t(1),
          endTime: t(5),
          revision: 1,
          eventTime: t(1.1),
          attributes: { amount: 199.0 }
        })
      ]
    },
    {
      label: 'inventory reports slow response initially ok',
      events: [
        span({
          traceId: traceA,
          spanId: 'inv-1',
          parentSpanId: 'pay-1',
          service: 'inventory',
          operation: 'reserveStock',
          kind: 'server',
          status: 'ok',
          startTime: t(2),
          endTime: t(6),
          revision: 1,
          eventTime: t(2.4),
          attributes: { sku: 'SKU-7' }
        })
      ]
    },
    {
      label: 'reconnect: collector reattaches and retries inventory',
      reconnect: true,
      events: [
        span({
          traceId: traceA,
          spanId: 'inv-1',
          parentSpanId: 'pay-1',
          service: 'inventory',
          operation: 'reserveStock',
          kind: 'server',
          status: 'error',
          startTime: t(2),
          endTime: t(8),
          revision: 2,
          eventTime: t(7),
          errorMessage: 'deadlock exceeded retry budget',
          attributes: { sku: 'SKU-7', retries: 3 }
        })
      ]
    },
    {
      label: 'late revision flips payment to error',
      events: [
        span({
          traceId: traceA,
          spanId: 'pay-1',
          parentSpanId: 'gw-1',
          service: 'payment',
          operation: 'charge',
          kind: 'client',
          status: 'error',
          startTime: t(1),
          endTime: t(8.5),
          revision: 2,
          eventTime: t(8.7),
          errorMessage: 'upstream inventory reserve failed',
          attributes: { amount: 199.0, fallback: false }
        })
      ]
    },
    {
      label: 'gateway finalizes with error after late child result',
      events: [
        span({
          traceId: traceA,
          spanId: 'gw-1',
          parentSpanId: null,
          service: 'gateway',
          operation: 'POST /checkout',
          kind: 'server',
          status: 'error',
          startTime: t(0),
          endTime: t(9),
          revision: 2,
          eventTime: t(9.2),
          errorMessage: '502 checkout failed downstream',
          attributes: { region: 'cn-north', route: '/checkout', httpStatus: 502 }
        })
      ]
    },
    {
      label: 'reconnect: second trace begins after reconnect',
      reconnect: true,
      events: [
        span({
          traceId: traceB,
          spanId: 'gw-2',
          parentSpanId: null,
          service: 'gateway',
          operation: 'GET /health',
          kind: 'server',
          status: 'ok',
          startTime: t(20),
          endTime: t(20.2),
          revision: 1,
          eventTime: t(20.05),
          attributes: { route: '/health' }
        }),
        span({
          traceId: traceB,
          spanId: 'db-2',
          parentSpanId: 'gw-2',
          service: 'database',
          operation: 'SELECT 1',
          kind: 'client',
          status: 'ok',
          startTime: t(20.05),
          endTime: t(20.15),
          revision: 1,
          eventTime: t(20.3),
          attributes: { pool: 'primary' }
        })
      ]
    },
    {
      label: 'late span with high eventTime after a gap',
      events: [
        span({
          traceId: traceA,
          spanId: 'notify-1',
          parentSpanId: 'gw-1',
          service: 'notifier',
          operation: 'enqueueFailure',
          kind: 'producer',
          status: 'error',
          startTime: t(9.1),
          endTime: t(9.6),
          revision: 1,
          eventTime: t(30),
          errorMessage: 'queue timeout',
          attributes: { topic: 'checkout-failed' }
        })
      ]
    }
  ];

  return batches;
}

export function flattenSampleStream(): readonly SpanEvent[] {
  return buildSampleStream().flatMap((batch) => batch.events);
}
