export const CONTRACT_VERSION = 1 as const;

export type SpanStatus = 'ok' | 'error';

export interface RawSpanEvent {
  contractVersion: typeof CONTRACT_VERSION;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  revision: number;
  eventTime: number;
  service: string;
  operation: string;
  status: SpanStatus;
  errorMessage: string | null;
  attributes: Record<string, string>;
}

export interface LedgerRecord {
  ingestSequence: number;
  ingestTime: number;
  event: RawSpanEvent;
}

export interface ReplayCursor {
  eventTime: number;
  ingestSequence: number;
}

export interface SpanView {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  revision: number;
  eventTime: number;
  ingestSequence: number;
  ingestTime: number;
  service: string;
  operation: string;
  status: SpanStatus;
  errorMessage: string | null;
  attributes: Record<string, string>;
  arrivalDelayMs: number;
}

export interface SpanVersionExplanation {
  traceId: string;
  spanId: string;
  revision: number;
  ingestSequence: number;
  ingestTime: number;
  eventTime: number;
  service: string;
  operation: string;
  status: SpanStatus;
  errorMessage: string | null;
  isCurrent: boolean;
  isDuplicate: boolean;
  becameCurrentAt: number | null;
  arrivalDelayMs: number;
  reason: string;
}

export interface ServiceNode {
  service: string;
  spanCount: number;
  errorCount: number;
  traceIds: string[];
}

export interface TopologyEdge {
  fromService: string;
  toService: string;
  traceId: string;
  parentSpanId: string;
  spanId: string;
  hasError: boolean;
}

export interface TraceSummary {
  traceId: string;
  spanCount: number;
  errorCount: number;
  services: string[];
  startTime: number;
  endTime: number;
  hasError: boolean;
}

export interface ReplayView {
  cursor: ReplayCursor;
  head: ReplayCursor;
  totalLedgerRecords: number;
  spans: SpanView[];
  services: ServiceNode[];
  edges: TopologyEdge[];
  traces: TraceSummary[];
}

export type SnapshotSlot = 'A' | 'B';

export interface IncidentSnapshot {
  id: string;
  slot: SnapshotSlot;
  label: string;
  cursor: ReplayCursor;
  ledgerHead: ReplayCursor;
  totalLedgerRecords: number;
  visibleRecordCount: number;
  digest: string;
  createdAt: number;
  notes: string;
}

export type SpanChangeField =
  | 'status'
  | 'revision'
  | 'service'
  | 'operation'
  | 'parentSpanId'
  | 'errorMessage';

export interface SpanChange {
  traceId: string;
  spanId: string;
  fields: SpanChangeField[];
  before: SpanView;
  after: SpanView;
}

export interface CriticalPathChange {
  traceId: string;
  rootErrorSpanId: string;
  beforePath: string[];
  afterPath: string[];
}

export interface SnapshotDiff {
  a: IncidentSnapshot;
  b: IncidentSnapshot;
  added: SpanView[];
  removed: SpanView[];
  changed: SpanChange[];
  criticalPathChanges: CriticalPathChange[];
  sameDigest: boolean;
  summary: {
    addedCount: number;
    removedCount: number;
    changedCount: number;
    criticalPathChangeCount: number;
  };
}

export interface CreateSnapshotRequest {
  slot: SnapshotSlot;
  label?: string;
  cursor: ReplayCursor;
  notes?: string;
}

export interface UpdateSnapshotNotesRequest {
  notes: string;
}


export interface HeadResponse {
  head: ReplayCursor;
  totalLedgerRecords: number;
}

export type IngestResult =
  | { accepted: number; rejected: number; firstSequence: number | null; lastSequence: number | null; errors: string[] }
  | { error: string };

export type WsServerMessage =
  | { type: 'record'; record: LedgerRecord; head: ReplayCursor }
  | { type: 'snapshot'; head: ReplayCursor; totalLedgerRecords: number }
  | { type: 'sample'; running: boolean };

export function makeRawSpanEvent(
  init: Omit<RawSpanEvent, 'contractVersion'>,
): RawSpanEvent {
  return { contractVersion: CONTRACT_VERSION, ...init };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function parseRawSpanEvent(value: unknown): RawSpanEvent {
  if (!isObject(value)) {
    throw new Error('span event must be an object');
  }
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw new Error(
      `unsupported contractVersion: expected ${CONTRACT_VERSION}, got ${String(value.contractVersion)}`,
    );
  }
  if (!isString(value.traceId) || value.traceId.length === 0) {
    throw new Error('traceId must be a non-empty string');
  }
  if (!isString(value.spanId) || value.spanId.length === 0) {
    throw new Error('spanId must be a non-empty string');
  }
  if (!isNullableString(value.parentSpanId)) {
    throw new Error('parentSpanId must be a string or null');
  }
  if (!isNumber(value.revision) || value.revision < 0 || !Number.isInteger(value.revision)) {
    throw new Error('revision must be a non-negative integer');
  }
  if (!isNumber(value.eventTime)) {
    throw new Error('eventTime must be a finite number');
  }
  if (!isString(value.service) || value.service.length === 0) {
    throw new Error('service must be a non-empty string');
  }
  if (!isString(value.operation) || value.operation.length === 0) {
    throw new Error('operation must be a non-empty string');
  }
  if (value.status !== 'ok' && value.status !== 'error') {
    throw new Error('status must be "ok" or "error"');
  }
  if (!isNullableString(value.errorMessage)) {
    throw new Error('errorMessage must be a string or null');
  }
  if (!isObject(value.attributes)) {
    throw new Error('attributes must be an object');
  }
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(value.attributes)) {
    if (!isString(v)) {
      throw new Error(`attribute ${k} must be a string`);
    }
    attributes[k] = v;
  }
  const event: RawSpanEvent = {
    contractVersion: CONTRACT_VERSION,
    traceId: value.traceId,
    spanId: value.spanId,
    parentSpanId: value.parentSpanId,
    revision: value.revision,
    eventTime: value.eventTime,
    service: value.service,
    operation: value.operation,
    status: value.status,
    errorMessage: value.errorMessage,
    attributes,
  };
  return event;
}

export function parseReplayCursor(value: unknown): ReplayCursor {
  if (!isObject(value)) {
    throw new Error('cursor must be an object');
  }
  if (!isNumber(value.eventTime)) {
    throw new Error('cursor.eventTime must be a number');
  }
  if (!isNumber(value.ingestSequence) || value.ingestSequence < 0) {
    throw new Error('cursor.ingestSequence must be a non-negative number');
  }
  return { eventTime: value.eventTime, ingestSequence: value.ingestSequence };
}

export function emptyHead(): ReplayCursor {
  return { eventTime: 0, ingestSequence: 0 };
}

export function parseSnapshotSlot(value: unknown): SnapshotSlot {
  if (value === 'A' || value === 'B') return value;
  throw new Error('slot must be "A" or "B"');
}

export function parseCreateSnapshotRequest(value: unknown): CreateSnapshotRequest {
  if (!isObject(value)) throw new Error('request must be an object');
  const slot = parseSnapshotSlot(value.slot);
  const cursor = parseReplayCursor(value.cursor);
  const label = value.label === undefined ? undefined : value.label;
  if (label !== undefined && !isString(label)) {
    throw new Error('label must be a string');
  }
  const notes = value.notes === undefined ? '' : value.notes;
  if (!isString(notes)) {
    throw new Error('notes must be a string');
  }
  return { slot, label, cursor, notes };
}
