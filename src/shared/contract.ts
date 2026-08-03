import { z } from 'zod';

/**
 * Contract version. Bump when the wire shape of a span event changes in an
 * incompatible way. Both the browser and the server assert on this value so a
 * stale client can never silently mis-read a newer ledger.
 */
export const CONTRACT_VERSION = 1 as const;

/** Span lifecycle status as reported by the emitting service. */
export const SpanStatus = z.enum(['ok', 'error']);
export type SpanStatus = z.infer<typeof SpanStatus>;

/**
 * A single immutable span *revision* as it arrives on the wire (NDJSON, one
 * JSON object per line). This is the raw, append-only fact. The server never
 * mutates it; it only assigns an `ingestSequence` on arrival.
 */
export const SpanEventInput = z.object({
  /** Contract version the producer wrote against. */
  contractVersion: z.literal(CONTRACT_VERSION),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  /** Parent span within the same trace; null for a root span. */
  parentSpanId: z.string().min(1).nullable(),
  /** Logical service that emitted the span. */
  service: z.string().min(1),
  /** Operation / endpoint name. */
  operation: z.string().min(1),
  /**
   * Monotonic per-(traceId,spanId) version. A higher revision supersedes a
   * lower one as the "current" version. Ties never win: equal revision keeps
   * the earlier arrival. Corrections/late edits re-send with a higher revision.
   */
  revision: z.number().int().nonnegative(),
  /** Wall-clock event time in epoch milliseconds (the incident timeline). */
  eventTimeMs: z.number().int().nonnegative(),
  /** Span duration in milliseconds. */
  durationMs: z.number().int().nonnegative(),
  status: SpanStatus,
  /** Optional human-facing reason this revision exists (e.g. correction note). */
  revisionReason: z.string().nullable().default(null),
  /** Optional error detail present when status === 'error'. */
  errorKind: z.string().nullable().default(null),
});
export type SpanEventInput = z.infer<typeof SpanEventInput>;

/**
 * A span event *after* it has been durably appended to the ledger. Carries the
 * server-assigned monotonic `ingestSequence`, which is the backbone of
 * reproducible replay: it encodes "how much knowledge had arrived".
 */
export const LedgerRecord = SpanEventInput.extend({
  ingestSequence: z.number().int().positive(),
  /** Server receive time in epoch ms (diagnostic only; never affects replay). */
  receivedAtMs: z.number().int().nonnegative(),
});
export type LedgerRecord = z.infer<typeof LedgerRecord>;

/**
 * A replay position. Any view is a pure function of a cursor over the immutable
 * ledger, so the same cursor always reproduces the same view regardless of
 * late, duplicate, out-of-order or reconnect-driven arrivals.
 *
 * - `ingestSequence`: only records with ingestSequence <= this are "known".
 *   Advancing it replays the order in which knowledge actually arrived.
 * - `eventTimeMs`: only spans whose eventTime <= this are "in the past" of the
 *   scrubbed incident moment. This is the timeline the on-call operator drags.
 */
export const ReplayCursor = z.object({
  eventTimeMs: z.number().int().nonnegative(),
  ingestSequence: z.number().int().nonnegative(),
});
export type ReplayCursor = z.infer<typeof ReplayCursor>;

/** Why a particular span version is the one shown at a cursor. */
export const VersionReason = z.object({
  chosenRevision: z.number().int().nonnegative(),
  chosenIngestSequence: z.number().int().positive(),
  /** Total revisions of this span known at/under the cursor. */
  knownRevisions: z.number().int().positive(),
  /** Highest revision that exists anywhere in the ledger (may be > chosen). */
  latestRevisionEver: z.number().int().nonnegative(),
  /** True when a newer revision exists but is beyond the current cursor. */
  supersededLater: z.boolean(),
  explanation: z.string(),
});
export type VersionReason = z.infer<typeof VersionReason>;

/** A resolved node in the projected topology at a given cursor. */
export const ProjectedSpan = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  service: z.string(),
  operation: z.string(),
  status: SpanStatus,
  revision: z.number().int().nonnegative(),
  eventTimeMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  ingestSequence: z.number().int().positive(),
  errorKind: z.string().nullable(),
  revisionReason: z.string().nullable(),
  /** True when this span or any descendant carries an error at this cursor. */
  onErrorPath: z.boolean(),
  versionReason: VersionReason,
});
export type ProjectedSpan = z.infer<typeof ProjectedSpan>;

/** A directed causal edge (parent -> child) in the projected topology. */
export const ProjectedEdge = z.object({
  fromSpanId: z.string(),
  toSpanId: z.string(),
  /** True when the child span is in an error state (error propagation). */
  propagatesError: z.boolean(),
});
export type ProjectedEdge = z.infer<typeof ProjectedEdge>;

/** The full reproducible view for one cursor. Pure projection, never stored. */
export const ProjectionView = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  cursor: ReplayCursor,
  spans: z.array(ProjectedSpan),
  edges: z.array(ProjectedEdge),
  /** Distinct services present in the view (stable, sorted). */
  services: z.array(z.string()),
  /** Bounds of the whole ledger, so the UI can build the timeline. */
  bounds: z.object({
    minEventTimeMs: z.number().int().nonnegative(),
    maxEventTimeMs: z.number().int().nonnegative(),
    maxIngestSequence: z.number().int().nonnegative(),
  }),
});
export type ProjectionView = z.infer<typeof ProjectionView>;

/** Envelope pushed over the websocket whenever the ledger head advances. */
export const LiveUpdate = z.object({
  type: z.literal('live'),
  contractVersion: z.literal(CONTRACT_VERSION),
  bounds: ProjectionView.shape.bounds,
  /** The newest appended record, so a follower can show incoming activity. */
  latest: LedgerRecord,
});
export type LiveUpdate = z.infer<typeof LiveUpdate>;

/** Sent once on websocket connect so the client can sync before deltas flow. */
export const LiveHello = z.object({
  type: z.literal('hello'),
  contractVersion: z.literal(CONTRACT_VERSION),
  bounds: ProjectionView.shape.bounds,
});
export type LiveHello = z.infer<typeof LiveHello>;

export const LiveMessage = z.discriminatedUnion('type', [LiveHello, LiveUpdate]);
export type LiveMessage = z.infer<typeof LiveMessage>;

/** Response for the batch ingest endpoint. */
export const IngestResult = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  maxIngestSequence: z.number().int().nonnegative(),
});
export type IngestResult = z.infer<typeof IngestResult>;

// ---------------------------------------------------------------------------
// Incident snapshots: two cursors sealed as immutable artifacts for comparison.
// ---------------------------------------------------------------------------

/**
 * Proof-of-origin for a sealed snapshot. The `ledgerHighWater` freezes exactly
 * how much of the append-only ledger existed when the snapshot was sealed, and
 * the `digest` is a deterministic fingerprint of the reproduced view over that
 * frozen slice. Same ledger slice + same cursor always yields the same digest,
 * so later (late) events can never rewrite an already-sealed result.
 */
export const SnapshotProvenance = z.object({
  /** Max ingestSequence present in the ledger at seal time (the frozen slice). */
  ledgerHighWater: z.number().int().nonnegative(),
  digestAlgorithm: z.literal('sha256'),
  /** Hex sha256 over the canonical, ledger-derived content of the snapshot. */
  digest: z.string().min(1),
});
export type SnapshotProvenance = z.infer<typeof SnapshotProvenance>;

/** An immutable, sealed replay position with investigation metadata. */
export const IncidentSnapshot = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  id: z.number().int().positive(),
  /** Human label, e.g. "A" / "B" or a free-form marker. Sealed at creation. */
  label: z.string().min(1),
  /** Investigation note attached at seal time; part of the immutable artifact. */
  note: z.string().nullable(),
  cursor: ReplayCursor,
  provenance: SnapshotProvenance,
  /** Server wall-clock at seal (diagnostic only; never affects the digest). */
  sealedAtMs: z.number().int().nonnegative(),
});
export type IncidentSnapshot = z.infer<typeof IncidentSnapshot>;

/** A sealed snapshot together with its reproduced, frozen projection. */
export const SnapshotView = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  snapshot: IncidentSnapshot,
  /** Reproduced deterministically from the frozen ledger slice at seal time. */
  view: ProjectionView,
});
export type SnapshotView = z.infer<typeof SnapshotView>;

/** Request body to seal the current cursor into an immutable snapshot. */
export const SealSnapshotRequest = z.object({
  label: z.string().min(1),
  note: z.string().nullable().default(null),
  cursor: ReplayCursor,
});
export type SealSnapshotRequest = z.infer<typeof SealSnapshotRequest>;

/** The resolved facts about one span at a snapshot, used for diffing. */
export const SpanFacet = z.object({
  service: z.string(),
  operation: z.string(),
  status: SpanStatus,
  revision: z.number().int().nonnegative(),
  onErrorPath: z.boolean(),
  errorKind: z.string().nullable(),
});
export type SpanFacet = z.infer<typeof SpanFacet>;

/** How a single span differs between snapshot A and snapshot B. */
export const SpanDelta = z.object({
  traceId: z.string(),
  spanId: z.string(),
  service: z.string(),
  operation: z.string(),
  /** added: only in B; removed: only in A; changed: present in both but differs. */
  presence: z.enum(['added', 'removed', 'changed']),
  statusChanged: z.boolean(),
  revisionChanged: z.boolean(),
  /** True when the span's membership on the error/critical path flipped. */
  pathChanged: z.boolean(),
  before: SpanFacet.nullable(),
  after: SpanFacet.nullable(),
});
export type SpanDelta = z.infer<typeof SpanDelta>;

/** A deterministic comparison between two sealed snapshots (A -> B). */
export const SnapshotComparison = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  from: IncidentSnapshot,
  to: IncidentSnapshot,
  added: z.array(SpanDelta),
  removed: z.array(SpanDelta),
  changed: z.array(SpanDelta),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    statusChanged: z.number().int().nonnegative(),
    pathChanged: z.number().int().nonnegative(),
    revisionChanged: z.number().int().nonnegative(),
  }),
});
export type SnapshotComparison = z.infer<typeof SnapshotComparison>;
