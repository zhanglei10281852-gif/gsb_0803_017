import type {
  HeadResponseV1,
  ReplayCursorV1,
  SealResponseV1,
  SnapshotDetailV1,
  SnapshotListV1,
  SnapshotNoteV1,
  SpanHistoryV1,
  VerifyReportV1,
} from "@replay/shared";

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

/* ---------- IncidentSnapshot ---------- */

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`请求失败：${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function listSnapshots(): Promise<SnapshotListV1> {
  return jsonOrThrow<SnapshotListV1>(await fetch("/api/snapshots"));
}

export async function sealSnapshot(
  cursorA: ReplayCursorV1,
  cursorB: ReplayCursorV1,
  label: string | null,
): Promise<SealResponseV1> {
  const res = await fetch("/api/snapshots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract: "seal-request/1", cursorA, cursorB, label }),
  });
  return jsonOrThrow<SealResponseV1>(res);
}

export async function getSnapshotDetail(id: string): Promise<SnapshotDetailV1> {
  return jsonOrThrow<SnapshotDetailV1>(await fetch(`/api/snapshots/${encodeURIComponent(id)}`));
}

export async function verifySnapshot(id: string): Promise<VerifyReportV1> {
  return jsonOrThrow<VerifyReportV1>(await fetch(`/api/snapshots/${encodeURIComponent(id)}/verify`));
}

export async function addSnapshotNote(
  id: string,
  author: string,
  text: string,
): Promise<SnapshotNoteV1> {
  const res = await fetch(`/api/snapshots/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author, text }),
  });
  return jsonOrThrow<SnapshotNoteV1>(res);
}
