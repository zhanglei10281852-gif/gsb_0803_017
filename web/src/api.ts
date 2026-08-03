import type { HeadResponseV1, ReplayCursorV1, SpanHistoryV1 } from "@replay/shared";

export async function fetchHead(): Promise<HeadResponseV1> {
  const res = await fetch("/api/head");
  if (!res.ok) throw new Error(`head 请求失败：${res.status}`);
  return (await res.json()) as HeadResponseV1;
}

export async function fetchSpanHistory(
  traceId: string,
  spanId: string,
  cursor: ReplayCursorV1,
): Promise<SpanHistoryV1> {
  const res = await fetch(
    `/api/span/${encodeURIComponent(traceId)}/${encodeURIComponent(spanId)}?eventTime=${cursor.eventTime}&ingestSequence=${cursor.ingestSequence}`,
  );
  if (!res.ok) throw new Error(`span 历史请求失败：${res.status}`);
  return (await res.json()) as SpanHistoryV1;
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--:--.---";
  return new Date(ms).toISOString().slice(11, 23);
}
