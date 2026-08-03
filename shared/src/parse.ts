/**
 * 契约解析器：所有外部输入（NDJSON 行、WS 消息、DB 回读）都经过显式收窄，
 * 全程使用 unknown + 类型守卫，不使用 any。
 */
import type {
  LedgerEntryV1,
  ReplayCursorV1,
  SealRequestV1,
  SpanEventV1,
  SpanStatus,
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
  return fail(`未知 kind：${String(kind)}`);
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
