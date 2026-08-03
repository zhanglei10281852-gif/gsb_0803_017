/**
 * 契约解析器：所有外部输入（NDJSON 行、WS 消息、DB 回读）都经过显式收窄，
 * 全程使用 unknown + 类型守卫，不使用 any。
 */
import type {
  InvestigationSessionV1,
  LeaseV1,
  LedgerEntryV1,
  ReplayCursorV1,
  SealRequestV1,
  SessionNoteV1,
  SessionParticipantV1,
  SpanEventV1,
  SpanStatus,
  WsClientMessageV1,
  WsServerMessageV1,
} from "./contract.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}
function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function reqString(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function optNullableString(r: Record<string, unknown>, key: string): string | null | undefined {
  const v = r[key];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : undefined;
}

function reqNumber(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function reqInt(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export function parseSpanEvent(input: unknown): ParseResult<SpanEventV1> {
  if (!isRecord(input)) return fail("事件不是 JSON 对象");
  if (input.contract !== "span-event/1") {
    return fail(`未知 contract：${String(input.contract)}`);
  }
  const producerId = reqString(input, "producerId");
  if (!producerId) return fail("producerId 缺失或非法");
  const eventId = reqString(input, "eventId");
  if (!eventId) return fail("eventId 缺失或非法");
  const traceId = reqString(input, "traceId");
  if (!traceId) return fail("traceId 缺失或非法");
  const spanId = reqString(input, "spanId");
  if (!spanId) return fail("spanId 缺失或非法");
  const parentSpanId = optNullableString(input, "parentSpanId");
  if (parentSpanId === undefined) return fail("parentSpanId 必须为 string 或 null");
  const service = reqString(input, "service");
  if (!service) return fail("service 缺失或非法");
  const operation = reqString(input, "operation");
  if (!operation) return fail("operation 缺失或非法");
  const eventTime = reqNumber(input, "eventTime");
  if (eventTime === null || eventTime < 0) return fail("eventTime 缺失或非法");
  const durationMs = reqNumber(input, "durationMs");
  if (durationMs === null || durationMs < 0) return fail("durationMs 缺失或非法");
  const revision = reqInt(input, "revision");
  if (revision === null || revision < 1) return fail("revision 必须为 >= 1 的整数");
  const rawStatus = input.status;
  if (rawStatus !== "ok" && rawStatus !== "error") return fail("status 必须为 ok | error");
  const status: SpanStatus = rawStatus;
  const errorMessage = optNullableString(input, "errorMessage");
  if (errorMessage === undefined) return fail("errorMessage 必须为 string 或 null");
  const rawAttrs = input.attributes;
  const attributes: Record<string, string> = {};
  if (rawAttrs !== undefined && rawAttrs !== null) {
    if (!isRecord(rawAttrs)) return fail("attributes 必须为 Record<string,string>");
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (typeof v !== "string") return fail(`attributes.${k} 必须为 string`);
      attributes[k] = v;
    }
  }
  return ok({
    contract: "span-event/1",
    producerId,
    eventId,
    traceId,
    spanId,
    parentSpanId,
    service,
    operation,
    eventTime,
    durationMs,
    revision,
    status,
    errorMessage,
    attributes,
  });
}

export function parseSpanEventLine(line: string): ParseResult<SpanEventV1> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return fail(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSpanEvent(raw);
}

export function parseCursor(input: unknown): ParseResult<ReplayCursorV1> {
  if (!isRecord(input)) return fail("游标不是 JSON 对象");
  if (input.contract !== "replay-cursor/1") return fail(`未知 contract：${String(input.contract)}`);
  const eventTime = reqNumber(input, "eventTime");
  if (eventTime === null || eventTime < 0) return fail("eventTime 非法");
  const ingestSequence = reqInt(input, "ingestSequence");
  if (ingestSequence === null || ingestSequence < 0) return fail("ingestSequence 非法");
  return ok({ contract: "replay-cursor/1", eventTime, ingestSequence });
}

export function parseLedgerEntry(input: unknown): ParseResult<LedgerEntryV1> {
  if (!isRecord(input)) return fail("账本条目不是 JSON 对象");
  if (input.contract !== "ledger-entry/1") return fail(`未知 contract：${String(input.contract)}`);
  const ingestSequence = reqInt(input, "ingestSequence");
  if (ingestSequence === null || ingestSequence < 1) return fail("ingestSequence 非法");
  const receivedAtMs = reqNumber(input, "receivedAtMs");
  if (receivedAtMs === null) return fail("receivedAtMs 非法");
  const event = parseSpanEvent(input.event);
  if (!event.ok) return fail(`event 非法：${event.error}`);
  return ok({
    contract: "ledger-entry/1",
    ingestSequence,
    receivedAtMs,
    event: event.value,
  });
}

export function parseWsServerMessage(input: unknown): ParseResult<WsServerMessageV1> {
  if (!isRecord(input)) return fail("WS 消息不是 JSON 对象");
  if (input.contract !== "ws/1") return fail(`未知 contract：${String(input.contract)}`);
  const kind = input.kind;
  if (kind === "hello") {
    const head = parseCursor(input.head);
    if (!head.ok) return fail(`hello.head 非法：${head.error}`);
    const totalEntries = reqInt(input, "totalEntries");
    if (totalEntries === null || totalEntries < 0) return fail("hello.totalEntries 非法");
    return ok({ contract: "ws/1", kind: "hello", head: head.value, totalEntries });
  }
  if (kind === "entry") {
    const entry = parseLedgerEntry(input.entry);
    if (!entry.ok) return fail(`entry 非法：${entry.error}`);
    return ok({ contract: "ws/1", kind: "entry", entry: entry.value });
  }
  if (kind === "live") {
    const head = parseCursor(input.head);
    if (!head.ok) return fail(`live.head 非法：${head.error}`);
    return ok({ contract: "ws/1", kind: "live", head: head.value });
  }
  if (kind === "session-state") {
    const state = parseInvestigationSession(input.state);
    if (!state.ok) return fail(`state 非法：${state.error}`);
    return ok({ contract: "ws/1", kind: "session-state", state: state.value });
  }
  return fail(`未知 kind：${String(kind)}`);
}

function parseLease(input: unknown): ParseResult<LeaseV1 | null> {
  if (input === null || input === undefined) return ok(null);
  if (!isRecord(input)) return fail("lease 不是对象");
  const holderId = reqString(input, "holderId");
  const holderName = reqString(input, "holderName");
  const fencingToken = reqInt(input, "fencingToken");
  const acquiredAtMs = reqNumber(input, "acquiredAtMs");
  const expiresAtMs = reqNumber(input, "expiresAtMs");
  const ttlMs = reqNumber(input, "ttlMs");
  if (!holderId || !holderName || fencingToken === null || acquiredAtMs === null || expiresAtMs === null || ttlMs === null) {
    return fail("lease 字段缺失");
  }
  return ok({ holderId, holderName, fencingToken, acquiredAtMs, expiresAtMs, ttlMs });
}

export function parseInvestigationSession(input: unknown): ParseResult<InvestigationSessionV1> {
  if (!isRecord(input)) return fail("会话不是 JSON 对象");
  if (input.contract !== "investigation-session/1") return fail(`未知 contract：${String(input.contract)}`);
  const sessionId = reqString(input, "sessionId");
  const anchorSnapshotId = reqString(input, "anchorSnapshotId");
  const anchorDigest = reqString(input, "anchorDigest");
  const createdBy = reqString(input, "createdBy");
  if (!sessionId || !anchorSnapshotId || !anchorDigest || !createdBy) return fail("会话字段缺失");
  const createdAtMs = reqNumber(input, "createdAtMs");
  const serverTimeMs = reqNumber(input, "serverTimeMs");
  if (createdAtMs === null || serverTimeMs === null) return fail("会话时间字段缺失");
  const sharedCursor = parseCursor(input.sharedCursor);
  if (!sharedCursor.ok) return fail(`sharedCursor 非法：${sharedCursor.error}`);
  const lease = parseLease(input.lease);
  if (!lease.ok) return fail(lease.error);
  const rawLabel = input.label;
  const label = typeof rawLabel === "string" ? rawLabel : null;
  const participants: SessionParticipantV1[] = [];
  if (!Array.isArray(input.participants)) return fail("participants 非法");
  for (const p of input.participants) {
    if (!isRecord(p)) return fail("participant 非法");
    const clientId = reqString(p, "clientId");
    const name = reqString(p, "name");
    const joinedAtMs = reqNumber(p, "joinedAtMs");
    const lastSeenMs = reqNumber(p, "lastSeenMs");
    if (!clientId || !name || joinedAtMs === null || lastSeenMs === null) return fail("participant 字段缺失");
    participants.push({ clientId, name, joinedAtMs, lastSeenMs });
  }
  const notes: SessionNoteV1[] = [];
  if (!Array.isArray(input.notes)) return fail("notes 非法");
  for (const n of input.notes) {
    if (!isRecord(n)) return fail("note 非法");
    const noteId = reqString(n, "noteId");
    const clientId = reqString(n, "clientId");
    const author = reqString(n, "author");
    const text = reqString(n, "text");
    const createdAtMsN = reqNumber(n, "createdAtMs");
    const seq = reqInt(n, "seq");
    if (!noteId || !clientId || !author || !text || createdAtMsN === null || seq === null) {
      return fail("note 字段缺失");
    }
    notes.push({ noteId, clientId, author, text, createdAtMs: createdAtMsN, seq });
  }
  const mergeDigest = reqString(input, "mergeDigest");
  if (!mergeDigest) return fail("mergeDigest 缺失");
  const snapshotIds: string[] = [];
  if (!Array.isArray(input.snapshotIds)) return fail("snapshotIds 非法");
  for (const s of input.snapshotIds) {
    if (typeof s !== "string") return fail("snapshotIds 非法");
    snapshotIds.push(s);
  }
  return ok({
    contract: "investigation-session/1",
    sessionId,
    anchorSnapshotId,
    anchorDigest,
    label,
    createdAtMs,
    createdBy,
    sharedCursor: sharedCursor.value,
    lease: lease.value,
    participants,
    notes,
    mergeDigest,
    snapshotIds,
    serverTimeMs,
  });
}

export function parseSealRequest(input: unknown): ParseResult<SealRequestV1> {
  if (!isRecord(input)) return fail("封存请求不是 JSON 对象");
  if (input.contract !== "seal-request/1") return fail(`未知 contract：${String(input.contract)}`);
  const cursorA = parseCursor(input.cursorA);
  if (!cursorA.ok) return fail(`cursorA 非法：${cursorA.error}`);
  const cursorB = parseCursor(input.cursorB);
  if (!cursorB.ok) return fail(`cursorB 非法：${cursorB.error}`);
  const rawLabel = input.label;
  let label: string | null = null;
  if (rawLabel !== undefined && rawLabel !== null) {
    if (typeof rawLabel !== "string") return fail("label 必须为 string 或 null");
    label = rawLabel.slice(0, 200);
  }
  return ok({ contract: "seal-request/1", cursorA: cursorA.value, cursorB: cursorB.value, label });
}

export interface NoteInput {
  author: string;
  text: string;
}

export function parseNoteInput(input: unknown): ParseResult<NoteInput> {
  if (!isRecord(input)) return fail("备注请求不是 JSON 对象");
  const rawAuthor = input.author;
  let author = "值班";
  if (rawAuthor !== undefined && rawAuthor !== null) {
    if (typeof rawAuthor !== "string" || rawAuthor.trim().length === 0) return fail("author 非法");
    author = rawAuthor.trim().slice(0, 40);
  }
  const rawText = input.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) return fail("text 不能为空");
  if (rawText.length > 2000) return fail("text 超长（<=2000）");
  return ok({ author, text: rawText.trim() });
}

/* ---------- InvestigationSession 请求解析 ---------- */

function reqName(r: Record<string, unknown>, key: string, max = 40): string | null {
  const v = r[key];
  if (typeof v !== "string" || v.trim().length === 0) return null;
  return v.trim().slice(0, max);
}

export interface CreateSessionInput {
  snapshotId: string;
  clientId: string;
  name: string;
  label: string | null;
}

export function parseCreateSession(input: unknown): ParseResult<CreateSessionInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const snapshotId = reqString(input, "snapshotId");
  if (!snapshotId) return fail("snapshotId 缺失");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const name = reqName(input, "name");
  if (!name) return fail("name 缺失");
  const rawLabel = input.label;
  const label = typeof rawLabel === "string" ? rawLabel.slice(0, 200) : null;
  return ok({ snapshotId, clientId, name, label });
}

export interface JoinSessionInput {
  clientId: string;
  name: string;
}

export function parseJoinSession(input: unknown): ParseResult<JoinSessionInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const name = reqName(input, "name");
  if (!name) return fail("name 缺失");
  return ok({ clientId, name });
}

export interface LeaseAcquireInput {
  clientId: string;
  name: string;
  ttlMs: number;
}

export function parseLeaseAcquire(input: unknown): ParseResult<LeaseAcquireInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const name = reqName(input, "name");
  if (!name) return fail("name 缺失");
  const ttlMs = reqNumber(input, "ttlMs") ?? 30_000;
  return ok({ clientId, name, ttlMs: Math.min(Math.max(ttlMs, 3_000), 120_000) });
}

export interface LeaseTokenInput {
  clientId: string;
  fencingToken: number;
  ttlMs: number;
}

export function parseLeaseToken(input: unknown): ParseResult<LeaseTokenInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const fencingToken = reqInt(input, "fencingToken");
  if (fencingToken === null || fencingToken < 1) return fail("fencingToken 非法");
  const ttlMs = reqNumber(input, "ttlMs") ?? 30_000;
  return ok({ clientId, fencingToken, ttlMs: Math.min(Math.max(ttlMs, 3_000), 120_000) });
}

export interface CursorPushInput {
  clientId: string;
  fencingToken: number;
  cursor: ReplayCursorV1;
}

export function parseCursorPush(input: unknown): ParseResult<CursorPushInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const fencingToken = reqInt(input, "fencingToken");
  if (fencingToken === null || fencingToken < 1) return fail("fencingToken 非法");
  const cursor = parseCursor(input.cursor);
  if (!cursor.ok) return fail(`cursor 非法：${cursor.error}`);
  return ok({ clientId, fencingToken, cursor: cursor.value });
}

export interface SessionSealInput {
  clientId: string;
  fencingToken: number;
  cursorA: ReplayCursorV1;
  cursorB: ReplayCursorV1;
  label: string | null;
}

export function parseSessionSeal(input: unknown): ParseResult<SessionSealInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const fencingToken = reqInt(input, "fencingToken");
  if (fencingToken === null || fencingToken < 1) return fail("fencingToken 非法");
  const cursorA = parseCursor(input.cursorA);
  if (!cursorA.ok) return fail(`cursorA 非法：${cursorA.error}`);
  const cursorB = parseCursor(input.cursorB);
  if (!cursorB.ok) return fail(`cursorB 非法：${cursorB.error}`);
  const rawLabel = input.label;
  const label = typeof rawLabel === "string" ? rawLabel.slice(0, 200) : null;
  return ok({ clientId, fencingToken, cursorA: cursorA.value, cursorB: cursorB.value, label });
}

export interface SessionNoteInput {
  clientId: string;
  author: string;
  text: string;
  noteId: string;
  createdAtMs: number;
}

export function parseSessionNote(input: unknown): ParseResult<SessionNoteInput> {
  if (!isRecord(input)) return fail("请求不是 JSON 对象");
  const clientId = reqString(input, "clientId");
  if (!clientId) return fail("clientId 缺失");
  const author = reqName(input, "author");
  if (!author) return fail("author 缺失");
  const rawText = input.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) return fail("text 不能为空");
  if (rawText.length > 2000) return fail("text 超长（<=2000）");
  const noteId = reqString(input, "noteId");
  if (!noteId) return fail("noteId 缺失");
  const createdAtMs = reqNumber(input, "createdAtMs");
  if (createdAtMs === null || createdAtMs < 0) return fail("createdAtMs 非法");
  return ok({ clientId, author, text: rawText.trim(), noteId, createdAtMs });
}

export function parseWsClientMessage(input: unknown): ParseResult<WsClientMessageV1> {
  if (!isRecord(input)) return fail("WS 客户端消息不是 JSON 对象");
  if (input.contract !== "ws-client/1") return fail(`未知 contract：${String(input.contract)}`);
  if (input.kind !== "subscribe-session") return fail(`未知 kind：${String(input.kind)}`);
  const raw = input.sessionId;
  if (raw !== null && typeof raw !== "string") return fail("sessionId 必须为 string 或 null");
  return ok({ contract: "ws-client/1", kind: "subscribe-session", sessionId: raw ?? null });
}
