import {
  AcquireLeaseResponse,
  AddNoteRequest,
  AdvanceCursorRequest,
  CreateSessionRequest,
  CreateSnapshotRequest,
  HealthResponse,
  IncidentSnapshot,
  InvestigationSession,
  LiveLedgerEvent,
  ReplayCursor,
  ReplayView,
  SealSnapshotInSessionRequest,
  SessionEvent,
  SpanDetail,
} from "../../shared/contracts";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${text}`);
  }
  return parsed;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("./api/health");
}

export function fetchView(
  cursor: ReplayCursor | null,
  live: boolean,
): Promise<ReplayView> {
  const params = new URLSearchParams();
  params.set("live", live ? "1" : "0");
  if (cursor && !live) {
    params.set("ingestSequence", String(cursor.ingestSequence));
    params.set("eventTime", String(cursor.eventTime));
  }
  return getJson<ReplayView>(`./api/view?${params.toString()}`);
}

export function fetchSpan(
  traceId: string,
  spanId: string,
  cursor: ReplayCursor | null,
  live: boolean,
): Promise<SpanDetail> {
  const params = new URLSearchParams();
  params.set("traceId", traceId);
  params.set("spanId", spanId);
  params.set("live", live ? "1" : "0");
  if (cursor && !live) {
    params.set("ingestSequence", String(cursor.ingestSequence));
    params.set("eventTime", String(cursor.eventTime));
  }
  return getJson<SpanDetail>(`./api/span?${params.toString()}`);
}

export function connectLiveSocket(
  onEvent: (event: LiveLedgerEvent) => void,
): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/replay`);
  ws.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data as string) as LiveLedgerEvent;
      onEvent(parsed);
    } catch {
      // ignore malformed frame
    }
  };
  return () => ws.close();
}

export async function listSnapshots(): Promise<IncidentSnapshot[]> {
  const response = await fetch("./api/snapshots", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`list snapshots failed: ${response.status}`);
  const payload = (await response.json()) as { snapshots: IncidentSnapshot[] };
  return payload.snapshots;
}

export async function createSnapshot(
  request: CreateSnapshotRequest,
): Promise<IncidentSnapshot> {
  const response = await fetch("./api/snapshots", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok)
    throw new Error(`create snapshot failed: ${response.status}`);
  return (await response.json()) as IncidentSnapshot;
}

export async function updateSnapshotNotes(
  id: string,
  notes: string,
): Promise<IncidentSnapshot> {
  const response = await fetch(`./api/snapshots/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!response.ok) throw new Error(`update notes failed: ${response.status}`);
  return (await response.json()) as IncidentSnapshot;
}

export function createSession(
  request: CreateSessionRequest,
): Promise<InvestigationSession> {
  return postJson<InvestigationSession>("./api/sessions", request);
}

export function fetchSession(id: string): Promise<InvestigationSession> {
  return getJson<InvestigationSession>(
    `./api/sessions/${encodeURIComponent(id)}`,
  );
}

export function acquireLease(
  sessionId: string,
  participantId: string,
  participantName: string,
  fencingToken: number,
): Promise<AcquireLeaseResponse> {
  return postJson<AcquireLeaseResponse>(
    `./api/sessions/${encodeURIComponent(sessionId)}/lease`,
    { participantId, participantName, fencingToken },
  );
}

export function advanceCursor(
  sessionId: string,
  request: AdvanceCursorRequest,
): Promise<InvestigationSession> {
  return postJson<InvestigationSession>(
    `./api/sessions/${encodeURIComponent(sessionId)}/cursor`,
    request,
  );
}

export function sealSessionSnapshot(
  sessionId: string,
  request: SealSnapshotInSessionRequest,
): Promise<InvestigationSession> {
  return postJson<InvestigationSession>(
    `./api/sessions/${encodeURIComponent(sessionId)}/seal`,
    request,
  );
}

export async function addSessionNote(
  request: AddNoteRequest,
): Promise<{ note: { id: string } }> {
  return postJson<{ note: { id: string } }>("./api/notes", request);
}

export function connectSessionSocket(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let ws: WebSocket | null = null;
  let closed = false;
  let retryTimer: number | null = null;

  const connect = () => {
    ws = new WebSocket(
      `${protocol}//${window.location.host}/replay/${encodeURIComponent(sessionId)}`,
    );
    ws.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data as string) as SessionEvent;
        onEvent(parsed);
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      if (!closed) {
        retryTimer = window.setTimeout(connect, 1500);
      }
    };
  };
  connect();

  return () => {
    closed = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    ws?.close();
  };
}
