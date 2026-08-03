import type {
  LiveMessage,
  ProjectionView,
  ReplayCursor,
} from '../shared/contract';
import { LiveMessage as LiveMessageSchema, ProjectionView as ProjectionViewSchema } from '../shared/contract';

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
