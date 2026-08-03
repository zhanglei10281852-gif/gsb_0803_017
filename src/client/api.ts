import type {
  ReplayCursor,
  ReplayView,
  HeadResponse,
  SpanVersionExplanation,
  WsServerMessage,
  IngestResult,
} from '@shared/contracts.js';

export interface SpanVersionsResponse {
  traceId: string;
  spanId: string;
  versions: SpanVersionExplanation[];
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export function fetchHead(): Promise<HeadResponse> {
  return jsonRequest<HeadResponse>('/api/head');
}

export function fetchReplay(cursor: ReplayCursor): Promise<ReplayView> {
  const params = new URLSearchParams({
    eventTime: String(cursor.eventTime),
    ingestSequence: String(cursor.ingestSequence),
  });
  return jsonRequest<ReplayView>(`/api/replay?${params.toString()}`);
}

export function fetchSpanVersions(
  traceId: string,
  spanId: string,
  cursor: ReplayCursor,
): Promise<SpanVersionsResponse> {
  const params = new URLSearchParams({
    eventTime: String(cursor.eventTime),
    ingestSequence: String(cursor.ingestSequence),
  });
  return jsonRequest<SpanVersionsResponse>(
    `/api/span/${encodeURIComponent(traceId)}/${encodeURIComponent(spanId)}?${params.toString()}`,
  );
}

export function startSample(): Promise<{ running: boolean; scheduled: number }> {
  return jsonRequest('/api/sample/start', { method: 'POST' });
}

export function stopSample(): Promise<{ running: boolean }> {
  return jsonRequest('/api/sample/stop', { method: 'POST' });
}

export function ingestNdjson(text: string): Promise<IngestResult> {
  return jsonRequest('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: text,
  });
}

export function connectLive(onMessage: (msg: WsServerMessage) => void): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as WsServerMessage;
      onMessage(msg);
    } catch {
      // ignore malformed
    }
  };
  return ws;
}
