export const CONTRACT_VERSION = 1;

export type SpanKind =
  | "client"
  | "server"
  | "producer"
  | "consumer"
  | "internal";

export type SpanStatus = "ok" | "error" | "unset";

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
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
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
  readonly kind: "newest-revision" | "first-seen" | "overwritten-later";
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
  readonly type: "ledger-appended";
  readonly maxIngestSequence: number;
  readonly maxEventTime: number;
  readonly totalRecords: number;
  readonly serverTime: number;
}

export interface SnapshotDigest {
  readonly ledgerHighWatermark: {
    readonly maxIngestSequence: number;
    readonly maxEventTime: number;
    readonly totalRecords: number;
  };
  readonly cursor: ReplayCursor;
  readonly visibleRecordCount: number;
  readonly recordsDigest: string;
  readonly viewFingerprint: string;
  readonly spanCount: number;
  readonly traceCount: number;
  readonly errorPathCount: number;
}

export type SpanDiffKind =
  | "added"
  | "removed"
  | "status-changed"
  | "revision-changed";

export interface SpanDiffEntry {
  readonly traceId: string;
  readonly spanId: string;
  readonly service: string;
  readonly operation: string;
  readonly kind: SpanDiffKind;
  readonly beforeRevision: number | null;
  readonly afterRevision: number | null;
  readonly beforeStatus: SpanStatus | null;
  readonly afterStatus: SpanStatus | null;
  readonly beforeErrorMessage: string | null;
  readonly afterErrorMessage: string | null;
  readonly detail: string;
}

export type CriticalPathChangeKind =
  | "path-extended"
  | "path-shortened"
  | "origin-changed"
  | "service-set-changed";

export interface CriticalPathDiff {
  readonly traceId: string;
  readonly key: string;
  readonly originSpanId: string | null;
  readonly beforePath: readonly string[];
  readonly afterPath: readonly string[];
  readonly beforeAffectedServices: readonly string[];
  readonly afterAffectedServices: readonly string[];
  readonly change: CriticalPathChangeKind;
}

export interface IncidentDiff {
  readonly added: readonly SpanDiffEntry[];
  readonly removed: readonly SpanDiffEntry[];
  readonly statusChanged: readonly SpanDiffEntry[];
  readonly revisionChanged: readonly SpanDiffEntry[];
  readonly criticalPathChanges: readonly CriticalPathDiff[];
  readonly summary: {
    readonly addedCount: number;
    readonly removedCount: number;
    readonly statusChangedCount: number;
    readonly revisionChangedCount: number;
    readonly criticalPathChangeCount: number;
  };
}

export interface IncidentSnapshot {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly id: string;
  readonly createdAt: number;
  readonly labelA: string;
  readonly labelB: string;
  readonly cursorA: ReplayCursor;
  readonly cursorB: ReplayCursor;
  readonly digestA: SnapshotDigest;
  readonly digestB: SnapshotDigest;
  readonly diff: IncidentDiff;
  readonly notes: string;
  readonly sealed: true;
}

export interface CreateSnapshotRequest {
  readonly labelA?: string;
  readonly labelB?: string;
  readonly cursorA: ReplayCursor;
  readonly cursorB: ReplayCursor;
  readonly notes?: string;
}

export interface UpdateSnapshotNotesRequest {
  readonly notes: string;
}

export type SessionRole = "leader" | "follower" | "observer";
export type SessionClientState = "following" | "independent" | "lease-lost";

export interface SessionNoteEntry {
  readonly id: string;
  readonly participantId: string;
  readonly participantName: string;
  readonly text: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface SharedCursor {
  readonly cursor: ReplayCursor;
  readonly label: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly snapshotId: string | null;
}

export interface FencingToken {
  readonly token: number;
  readonly leaderId: string;
  readonly leaderName: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface InvestigationSession {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly id: string;
  readonly anchorSnapshotId: string;
  readonly anchorDigestA: string;
  readonly anchorDigestB: string;
  readonly lease: FencingToken | null;
  readonly sharedCursor: SharedCursor | null;
  readonly notes: readonly SessionNoteEntry[];
  readonly snapshotIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateSessionRequest {
  readonly anchorSnapshotId: string;
  readonly participantId: string;
  readonly participantName: string;
}

export interface AcquireLeaseRequest {
  readonly participantId: string;
  readonly participantName: string;
  readonly fencingToken: number;
}

export interface AcquireLeaseResponse {
  readonly ok: boolean;
  readonly lease: FencingToken | null;
  readonly reason:
    | "acquired"
    | "renewed"
    | "rejected-active-lease"
    | "stale-token";
}

export interface AdvanceCursorRequest {
  readonly participantId: string;
  readonly fencingToken: number;
  readonly cursor: ReplayCursor;
  readonly label: string;
  readonly snapshotId?: string | null;
}

export interface SealSnapshotInSessionRequest {
  readonly participantId: string;
  readonly fencingToken: number;
  readonly cursor: ReplayCursor;
  readonly label: string;
  readonly notes?: string;
}

export interface AddNoteRequest {
  readonly sessionId: string;
  readonly participantId: string;
  readonly participantName: string;
  readonly text: string;
  readonly clientNoteId: string;
}

export type SessionEvent =
  | {
      readonly type: "session-state";
      readonly session: InvestigationSession;
      readonly yourRole: SessionRole;
      readonly yourState: SessionClientState;
    }
  | { readonly type: "lease-changed"; readonly lease: FencingToken | null }
  | { readonly type: "cursor-advanced"; readonly sharedCursor: SharedCursor }
  | { readonly type: "note-added"; readonly note: SessionNoteEntry }
  | {
      readonly type: "snapshot-sealed";
      readonly snapshotId: string;
      readonly snapshot: IncidentSnapshot;
    };
