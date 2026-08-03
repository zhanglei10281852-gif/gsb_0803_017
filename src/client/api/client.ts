import {
  HealthResponse,
  LiveLedgerEvent,
  ReplayCursor,
  ReplayView,
  SpanDetail
} from '../../shared/contracts';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>('./api/health');
}

export function fetchView(cursor: ReplayCursor | null, live: boolean): Promise<ReplayView> {
  const params = new URLSearchParams();
  params.set('live', live ? '1' : '0');
  if (cursor && !live) {
    params.set('ingestSequence', String(cursor.ingestSequence));
    params.set('eventTime', String(cursor.eventTime));
  }
  return getJson<ReplayView>(`./api/view?${params.toString()}`);
}

export function fetchSpan(
  traceId: string,
  spanId: string,
  cursor: ReplayCursor | null,
  live: boolean
): Promise<SpanDetail> {
  const params = new URLSearchParams();
  params.set('traceId', traceId);
  params.set('spanId', spanId);
  params.set('live', live ? '1' : '0');
  if (cursor && !live) {
    params.set('ingestSequence', String(cursor.ingestSequence));
    params.set('eventTime', String(cursor.eventTime));
  }
  return getJson<SpanDetail>(`./api/span?${params.toString()}`);
}

export function connectLiveSocket(onEvent: (event: LiveLedgerEvent) => void): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
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
