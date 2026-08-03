import {
  CONTRACT_VERSION,
  SpanAttributes,
  SpanEvent,
  SpanKind,
  SpanStatus
} from './contracts';

const SPAN_KINDS: readonly SpanKind[] = ['client', 'server', 'producer', 'consumer', 'internal'];
const SPAN_STATUSES: readonly SpanStatus[] = ['ok', 'error', 'unset'];

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateAttributes(value: unknown): ValidationResult<SpanAttributes> {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!isObject(value)) {
    return { ok: false, error: 'attributes must be an object' };
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = raw;
    } else {
      return { ok: false, error: `attribute ${key} must be string|number|boolean` };
    }
  }
  return { ok: true, value: result };
}

export function validateSpanEvent(raw: unknown): ValidationResult<SpanEvent> {
  if (!isObject(raw)) {
    return { ok: false, error: 'event must be a JSON object' };
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, error: `contractVersion must be ${CONTRACT_VERSION}` };
  }
  if (!isNonEmptyString(raw.traceId)) return { ok: false, error: 'traceId required' };
  if (!isNonEmptyString(raw.spanId)) return { ok: false, error: 'spanId required' };
  if (raw.parentSpanId !== null && !isNonEmptyString(raw.parentSpanId)) {
    return { ok: false, error: 'parentSpanId must be string or null' };
  }
  if (!isNonEmptyString(raw.service)) return { ok: false, error: 'service required' };
  if (!isNonEmptyString(raw.operation)) return { ok: false, error: 'operation required' };
  if (!SPAN_KINDS.includes(raw.kind as SpanKind)) {
    return { ok: false, error: `kind must be one of ${SPAN_KINDS.join(',')}` };
  }
  if (!SPAN_STATUSES.includes(raw.status as SpanStatus)) {
    return { ok: false, error: `status must be one of ${SPAN_STATUSES.join(',')}` };
  }
  if (!isFiniteNumber(raw.startTime)) return { ok: false, error: 'startTime must be finite number' };
  if (!isFiniteNumber(raw.endTime)) return { ok: false, error: 'endTime must be finite number' };
  if (!isFiniteNumber(raw.revision) || raw.revision < 0 || !Number.isInteger(raw.revision)) {
    return { ok: false, error: 'revision must be non-negative integer' };
  }
  if (!isFiniteNumber(raw.eventTime)) return { ok: false, error: 'eventTime must be finite number' };
  if (raw.endTime < raw.startTime) {
    return { ok: false, error: 'endTime must be >= startTime' };
  }
  if (raw.errorMessage !== undefined && typeof raw.errorMessage !== 'string') {
    return { ok: false, error: 'errorMessage must be string when present' };
  }
  const attrs = validateAttributes(raw.attributes);
  if (!attrs.ok) return { ok: false, error: attrs.error };

  const value: SpanEvent = {
    contractVersion: CONTRACT_VERSION,
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId as string | null,
    service: raw.service,
    operation: raw.operation,
    kind: raw.kind as SpanKind,
    status: raw.status as SpanStatus,
    startTime: raw.startTime,
    endTime: raw.endTime,
    revision: raw.revision,
    eventTime: raw.eventTime,
    errorMessage: raw.errorMessage,
    attributes: attrs.value
  };
  return { ok: true, value };
}

export function parseNdjson(text: string): { events: SpanEvent[]; errors: string[] } {
  const events: SpanEvent[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      errors.push(`line ${index + 1}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    const result = validateSpanEvent(parsed);
    if (result.ok) {
      events.push(result.value);
    } else {
      errors.push(`line ${index + 1}: ${result.error}`);
    }
  }
  return { events, errors };
}
