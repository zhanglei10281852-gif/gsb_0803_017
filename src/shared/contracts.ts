export const CONTRACT_VERSION = 1;

export type SpanKind = 'client' | 'server' | 'producer' | 'consumer' | 'internal';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanAttributes {
  readonly [key: string]: string | number | boolean;
}

export interface SpanEvent {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly service: string;
  readonly operation: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly startTime: number;
  readonly endTime: number;
  readonly revision: number;
  readonly eventTime: number;
  readonly errorMessage?: string;
  readonly attributes?: SpanAttributes;
}

export interface LedgerRecord {
  readonly ingestSequence: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly service: string;
  readonly operation: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly startTime: number;
  readonly endTime: number;
  readonly revision: number;
  readonly eventTime: number;
  readonly errorMessage: string | null;
  readonly attributes: SpanAttributes;
  readonly receivedAt: number;
}

export interface ReplayCursor {
  readonly eventTime: number;
  readonly ingestSequence: number;
}

export interface TopologyNode {
  readonly id: string;
  readonly service: string;
  readonly spanCount: number;
  readonly errorCount: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

export interface TopologyEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly callCount: number;
  readonly errorCount: number;
}

export interface CurrentSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly service: string;
  readonly operation: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly startTime: number;
  readonly endTime: number;
  readonly revision: number;
  readonly eventTime: number;
  readonly errorMessage: string | null;
  readonly attributes: SpanAttributes;
  readonly activeAt: ReplayCursor;
  readonly effectiveReason: EffectiveReason;
}

export interface SpanVersion {
  readonly ingestSequence: number;
  readonly revision: number;
  readonly eventTime: number;
  readonly status: SpanStatus;
  readonly service: string;
  readonly operation: string;
  readonly errorMessage: string | null;
  readonly visibleAtCursor: boolean;
  readonly selectedAtCursor: boolean;
  readonly reason: string;
}

export interface SpanDetail {
  readonly traceId: string;
  readonly spanId: string;
  readonly current: CurrentSpan;
  readonly versions: readonly SpanVersion[];
}

export interface TraceSummary {
  readonly traceId: string;
  readonly serviceCount: number;
  readonly spanCount: number;
  readonly errorCount: number;
  readonly rootService: string | null;
  readonly minStartTime: number;
  readonly maxEndTime: number;
}

export interface ErrorPropagationPath {
  readonly traceId: string;
  readonly path: readonly string[];
  readonly originSpanId: string;
  readonly originService: string;
  readonly affectedServices: readonly string[];
}

export interface EffectiveReason {
  readonly kind: 'newest-revision' | 'first-seen' | 'overwritten-later';
  readonly comparedVersions: number;
  readonly winningIngestSequence: number;
  readonly detail: string;
}

export interface ReplayView {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly cursor: ReplayCursor;
  readonly live: boolean;
  readonly ledgerInfo: {
    readonly totalRecords: number;
    readonly minIngestSequence: number;
    readonly maxIngestSequence: number;
    readonly minEventTime: number;
    readonly maxEventTime: number;
  };
  readonly traces: readonly TraceSummary[];
  readonly spans: readonly CurrentSpan[];
  readonly topology: {
    readonly nodes: readonly TopologyNode[];
    readonly edges: readonly TopologyEdge[];
  };
  readonly errorPaths: readonly ErrorPropagationPath[];
  readonly generatedAt: number;
}

export interface IngestResponse {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly accepted: number;
  readonly rejected: number;
  readonly firstIngestSequence: number | null;
  readonly lastIngestSequence: number | null;
  readonly errors: readonly string[];
}

export interface HealthResponse {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly ok: true;
  readonly ledgerTotalRecords: number;
  readonly maxIngestSequence: number;
  readonly serverTime: number;
}

export interface LiveLedgerEvent {
  readonly type: 'ledger-appended';
  readonly maxIngestSequence: number;
  readonly maxEventTime: number;
  readonly totalRecords: number;
  readonly serverTime: number;
}
