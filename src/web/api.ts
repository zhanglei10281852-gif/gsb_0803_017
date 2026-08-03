import type {
  LiveMessage,
  ProjectionView,
  ReplayCursor,
  IncidentSnapshot,
  SnapshotView,
  SnapshotComparison,
} from '../shared/contract';
import {
  LiveMessage as LiveMessageSchema,
  ProjectionView as ProjectionViewSchema,
  IncidentSnapshot as IncidentSnapshotSchema,
  SnapshotView as SnapshotViewSchema,
  SnapshotComparison as SnapshotComparisonSchema,
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

/** Open the live-follow websocket. Auto-reconnects; validates every message. */
export function openLive(onMessage: (msg: LiveMessage) => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retry = 0;

  const connect = (): void => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/api/live`);
    socket.onmessage = (ev) => {
      try {
        const parsed = LiveMessageSchema.parse(JSON.parse(ev.data as string));
        onMessage(parsed);
      } catch {
        /* ignore malformed frame */
      }
    };
    socket.onopen = () => {
      retry = 0;
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
}): Promise<SnapshotView> {
  const res = await fetch('/api/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
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
