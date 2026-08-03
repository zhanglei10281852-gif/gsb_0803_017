import type {
  ProjectionView,
  ReplayCursor,
  IncidentSnapshot,
  SnapshotView,
  SnapshotComparison,
  SocketMessage,
  SessionState,
  InvestigationNote,
} from '../shared/contract';
import {
  ProjectionView as ProjectionViewSchema,
  IncidentSnapshot as IncidentSnapshotSchema,
  SnapshotView as SnapshotViewSchema,
  SnapshotComparison as SnapshotComparisonSchema,
  SocketMessage as SocketMessageSchema,
  SessionState as SessionStateSchema,
} from '../shared/contract';
import { z } from 'zod';

/** Fetch the reproducible projection at a cursor. Validates against the contract. */
export async function fetchView(cursor: ReplayCursor): Promise<ProjectionView> {
  const url = `/api/view?eventTimeMs=${cursor.eventTimeMs}&ingestSequence=${cursor.ingestSequence}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`view request failed: ${res.status}`);
  const json: unknown = await res.json();
  return ProjectionViewSchema.parse(json);
}

export interface Bounds {
  minEventTimeMs: number;
  maxEventTimeMs: number;
  maxIngestSequence: number;
}

export async function fetchBounds(): Promise<Bounds> {
  const res = await fetch('/api/bounds');
  if (!res.ok) throw new Error(`bounds request failed: ${res.status}`);
  const json = (await res.json()) as { bounds: Bounds };
  return json.bounds;
}

/**
 * Open the live socket. Auto-reconnects; validates every frame. `onReconnect`
 * fires after a successful (re)open so the client can refetch authoritative
 * state (bounds + any joined session) — the socket is an optimisation, the REST
 * state is the source of truth.
 */
export function openLive(
  onMessage: (msg: SocketMessage) => void,
  onReconnect?: () => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retry = 0;

  const connect = (): void => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/api/live`);
    socket.onmessage = (ev) => {
      try {
        const parsed = SocketMessageSchema.parse(JSON.parse(ev.data as string));
        onMessage(parsed);
      } catch {
        /* ignore malformed frame */
      }
    };
    socket.onopen = () => {
      retry = 0;
      onReconnect?.();
    };
    socket.onclose = () => {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 250 * retry);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };
  connect();

  return () => {
    closed = true;
    socket?.close();
  };
}

// --- Snapshots & comparison ---

/** Seal the given cursor into an immutable snapshot with an optional note. */
export async function sealSnapshot(input: {
  label: string;
  note: string | null;
  cursor: ReplayCursor;
  /** When set, the seal is gated by the session lease + fencing token. */
  writer?: { sessionId: number; holder: string; fencingToken: number };
}): Promise<SnapshotView> {
  const res = await fetch('/api/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { reason?: string };
    throw new Error(`封存被拒绝：你不是当前租约持有者（${body.reason ?? 'conflict'}）`);
  }
  if (!res.ok) throw new Error(`seal snapshot failed: ${res.status}`);
  const json: unknown = await res.json();
  return SnapshotViewSchema.parse(json);
}

const SnapshotListSchema = z.object({ snapshots: z.array(IncidentSnapshotSchema) });

export async function listSnapshots(): Promise<IncidentSnapshot[]> {
  const res = await fetch('/api/snapshots');
  if (!res.ok) throw new Error(`list snapshots failed: ${res.status}`);
  const json: unknown = await res.json();
  return SnapshotListSchema.parse(json).snapshots;
}

/** Deterministic A -> B comparison of two sealed snapshots. */
export async function compareSnapshots(fromId: number, toId: number): Promise<SnapshotComparison> {
  const res = await fetch(`/api/compare?from=${fromId}&to=${toId}`);
  if (!res.ok) throw new Error(`compare failed: ${res.status}`);
  const json: unknown = await res.json();
  return SnapshotComparisonSchema.parse(json);
}

// --- Collaboration sessions ---

async function sessionCall(url: string, method: string, body?: unknown): Promise<SessionState> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 409) {
    const err = (await res.json()) as { error?: string };
    throw new Error(err.error ?? 'conflict');
  }
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status}`);
  const json: unknown = await res.json();
  return SessionStateSchema.parse(json);
}

export async function createSession(input: {
  label: string;
  anchorSnapshotId: number;
  anchorDigest: string;
}): Promise<SessionState> {
  return sessionCall('/api/sessions', 'POST', input);
}

export async function fetchSession(id: number): Promise<SessionState | null> {
  const res = await fetch(`/api/sessions/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch session failed: ${res.status}`);
  return SessionStateSchema.parse(await res.json());
}

export async function acquireLease(id: number, holder: string, ttlMs?: number): Promise<SessionState> {
  return sessionCall(`/api/sessions/${id}/lease`, 'POST', { holder, ttlMs });
}

export async function renewLease(id: number, holder: string, fencingToken: number, ttlMs?: number): Promise<SessionState> {
  return sessionCall(`/api/sessions/${id}/lease`, 'PUT', { holder, fencingToken, ttlMs });
}

export async function releaseLease(id: number, holder: string, fencingToken: number): Promise<SessionState> {
  return sessionCall(`/api/sessions/${id}/lease`, 'DELETE', { holder, fencingToken });
}

export async function advanceSharedCursor(
  id: number,
  holder: string,
  fencingToken: number,
  cursor: ReplayCursor,
): Promise<SessionState> {
  return sessionCall(`/api/sessions/${id}/cursor`, 'POST', { holder, fencingToken, cursor });
}

export async function addNote(id: number, note: InvestigationNote): Promise<SessionState> {
  return sessionCall(`/api/sessions/${id}/notes`, 'POST', { note });
}
