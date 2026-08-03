/**
 * 版本化事件契约：前后端共享。
 * 所有跨进程数据结构都带有 `contract` 判别字段，禁止以 any 绕过。
 */

export const CONTRACT_VERSION = 1 as const;

export type SpanStatus = "ok" | "error";

/** 采集端上报的 span 事件（NDJSON 每行一个）。 */
export interface SpanEventV1 {
  contract: "span-event/1";
  /** 采集端标识；与 eventId 共同构成幂等键，断线重连重发可被去重。 */
  producerId: string;
  eventId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operation: string;
  /** 逻辑时间：span 开始时刻（epoch ms）。 */
  eventTime: number;
  durationMs: number;
  /** 同一 (traceId, spanId) 下只有更高 revision 能成为当前版本。 */
  revision: number;
  status: SpanStatus;
  errorMessage: string | null;
  attributes: Record<string, string>;
}

/** 回放游标：双坐标 (eventTime, ingestSequence)，同一游标永远生成同一视图。 */
export interface ReplayCursorV1 {
  contract: "replay-cursor/1";
  eventTime: number;
  ingestSequence: number;
}

/** 追加式账本条目：ingestSequence 由服务端单调分配。 */
export interface LedgerEntryV1 {
  contract: "ledger-entry/1";
  ingestSequence: number;
  receivedAtMs: number;
  event: SpanEventV1;
}

export type IngestOutcome = "accepted" | "duplicate";

export interface IngestReceiptV1 {
  contract: "ingest-receipt/1";
  producerId: string;
  eventId: string;
  ingestSequence: number;
  outcome: IngestOutcome;
}

export interface IngestBatchResultV1 {
  contract: "ingest-batch/1";
  accepted: number;
  duplicates: number;
  rejected: Array<{ line: number; error: string }>;
  receipts: IngestReceiptV1[];
}

/** 某游标处一个 span 的当前版本摘要（投影产物，可随时从账本重建）。 */
export interface SpanSummaryV1 {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operation: string;
  eventTime: number;
  durationMs: number;
  revision: number;
  status: SpanStatus;
  errorMessage: string | null;
  ingestSequence: number;
  versionCount: number;
}

export interface ServiceNodeV1 {
  service: string;
  spanCount: number;
  errorCount: number;
  activeCount: number;
}

export interface ServiceEdgeV1 {
  fromService: string;
  toService: string;
  callCount: number;
  errorCount: number;
  traceIds: string[];
}

export interface ReplayTotalsV1 {
  entries: number;
  visibleSpans: number;
  errorSpans: number;
  /** ingest 序列在游标之后的事件数（暂停期间新到达）。 */
  lateArrivalsBeyondCursor: number;
  /** 其中 eventTime 仍落在游标时点之前的（“写入过去”的迟到事件）。 */
  lateArrivalsIntoPast: number;
}

export interface ReplayViewV1 {
  contract: "replay-view/1";
  cursor: ReplayCursorV1;
  head: ReplayCursorV1;
  spans: SpanSummaryV1[];
  services: ServiceNodeV1[];
  edges: ServiceEdgeV1[];
  totals: ReplayTotalsV1;
}

export type VersionRole = "current" | "superseded" | "stale-on-arrival" | "beyond-cursor";

export interface VersionExplanationV1 {
  revision: number;
  ingestSequence: number;
  eventTime: number;
  status: SpanStatus;
  role: VersionRole;
  reason: string;
}

export interface SpanHistoryV1 {
  contract: "span-history/1";
  traceId: string;
  spanId: string;
  cursor: ReplayCursorV1;
  currentRevision: number | null;
  versions: VersionExplanationV1[];
}

/** 从根到目标 span 的因果链（同 trace 内沿 parentSpanId 回溯）。 */
export interface CausalPathV1 {
  contract: "causal-path/1";
  traceId: string;
  spanId: string;
  chain: SpanSummaryV1[];
  errorSpanIds: string[];
}

export type WsServerMessageV1 =
  | { contract: "ws/1"; kind: "hello"; head: ReplayCursorV1; totalEntries: number }
  | { contract: "ws/1"; kind: "entry"; entry: LedgerEntryV1 }
  | { contract: "ws/1"; kind: "live"; head: ReplayCursorV1 };

export interface HeadResponseV1 {
  contract: "head/1";
  contractVersion: number;
  cursor: ReplayCursorV1;
  totalEntries: number;
  distinctSpans: number;
  services: string[];
}

export interface RebuildReportV1 {
  contract: "rebuild-report/1";
  before: string;
  after: string;
  match: boolean;
  rows: number;
}
