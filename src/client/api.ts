import type {
  ReplayCursor,
  ReplayView,
  HeadResponse,
  SpanVersionExplanation,
  WsServerMessage,
  IngestResult,
  IncidentSnapshot,
  SnapshotDiff,
  SnapshotSlot,
  LeaseState,
  SessionNote,
  LeaseError,
  WsClientMessage,
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

export function createSnapshot(
  slot: SnapshotSlot,
  cursor: ReplayCursor,
  label?: string,
  notes?: string,
  fencing?: { clientId: string; token: number } | null,
): Promise<IncidentSnapshot> {
  return jsonRequest<IncidentSnapshot>('/api/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slot,
      cursor,
      label,
      notes: notes ?? '',
      fencingToken: fencing?.token ?? null,
      clientId: fencing?.clientId ?? null,
    }),
  });
}

export function listSnapshots(): Promise<{ snapshots: IncidentSnapshot[] }> {
  return jsonRequest('/api/snapshots');
}

export function getSnapshot(id: string): Promise<IncidentSnapshot> {
  return jsonRequest(`/api/snapshots/${encodeURIComponent(id)}`);
}

export function getLatestSnapshot(slot: SnapshotSlot): Promise<IncidentSnapshot> {
  return jsonRequest(`/api/snapshots/slot/${slot}`);
}

export function updateSnapshotNotes(id: string, notes: string): Promise<IncidentSnapshot> {
  return jsonRequest(`/api/snapshots/${encodeURIComponent(id)}/notes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
}

export function compareSnapshots(aId?: string, bId?: string): Promise<SnapshotDiff> {
  const params = new URLSearchParams();
  if (aId) params.set('a', aId);
  if (bId) params.set('b', bId);
  const qs = params.toString();
  return jsonRequest<SnapshotDiff>(`/api/snapshots/compare${qs ? `?${qs}` : ''}`);
}

export interface SessionState {
  lease: LeaseState | null;
  sharedCursor: ReplayCursor;
  notes: SessionNote[];
}

export interface AcquireResponse {
  ok: boolean;
  lease: LeaseState | null;
  error: LeaseError | null;
  acquired: boolean;
}

export function fetchSession(): Promise<SessionState> {
  return jsonRequest('/api/session');
}

export function acquireLease(clientId: string, clientName: string, ttlMs = 30000): Promise<AcquireResponse> {
  return jsonRequest('/api/session/lease', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientName, ttlMs }),
  });
}

export function renewLease(clientId: string, fencingToken: number): Promise<AcquireResponse> {
  return jsonRequest('/api/session/lease/renew', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, fencingToken }),
  });
}

export function releaseLease(clientId: string, fencingToken: number): Promise<{ ok: boolean }> {
  return jsonRequest('/api/session/lease/release', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, fencingToken }),
  });
}

export async function advanceSharedCursor(
  clientId: string,
  fencingToken: number,
  cursor: ReplayCursor,
): Promise<{ ok: boolean; error?: LeaseError }> {
  try {
    await jsonRequest('/api/session/cursor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, fencingToken, cursor }),
    });
    return { ok: true };
  } catch (e) {
    try {
      const parsed = JSON.parse((e as Error).message.replace(/^HTTP \d+: /, '')) as { error?: LeaseError };
      if (parsed.error) return { ok: false, error: parsed.error };
    } catch { /* fall through */ }
    return { ok: false };
  }
}

export function addSessionNote(note: {
  clientId: string;
  clientSeq: number;
  authorName: string;
  text: string;
  snapshotId: string | null;
  createdAt?: number;
}): Promise<{ ok: boolean; note: SessionNote; isNew: boolean }> {
  return jsonRequest('/api/session/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

export function sendWs(ws: WebSocket, msg: WsClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
