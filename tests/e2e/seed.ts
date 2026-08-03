import { buildScript } from '../../src/sample/script';
import { toNdjson } from '../../src/shared/ndjson';
import type { SpanEventInput } from '../../src/shared/contract';

/** POST NDJSON to a running server over real HTTP. */
export async function ingest(baseUrl: string, events: SpanEventInput[]): Promise<{ accepted: number; duplicates: number; maxIngestSequence: number }> {
  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: toNdjson(events),
  });
  if (!res.ok && res.status !== 207) throw new Error(`ingest failed: ${res.status}`);
  return (await res.json()) as { accepted: number; duplicates: number; maxIngestSequence: number };
}

/**
 * Seed the deterministic incident in "sessions" to emulate reconnecting
 * collectors replaying buffered spans (duplicates + out-of-order arrival).
 */
export async function seedIncident(baseUrl: string, seed = 1, sessions = 3): Promise<void> {
  const events = buildScript(seed).map((s) => s.event);
  const perSession = Math.max(1, Math.ceil(events.length / sessions));
  let tail: SpanEventInput[] = [];
  for (let s = 0; s < sessions; s++) {
    const slice = events.slice(s * perSession, (s + 1) * perSession);
    if (slice.length === 0) continue;
    await ingest(baseUrl, tail.length ? [...tail, ...slice] : slice);
    tail = slice.slice(-1);
  }
}

export { buildScript };
