import { SpanEventInput, type SpanEventInput as SpanEventInputT } from './contract';

export interface NdjsonParseResult {
  events: SpanEventInputT[];
  errors: Array<{ line: number; message: string }>;
}

/**
 * Parse an NDJSON body (one JSON span event per line) into validated events.
 * Blank lines are ignored. Invalid lines are collected rather than thrown so a
 * single bad line never drops a whole batch.
 */
export function parseNdjson(body: string): NdjsonParseResult {
  const events: SpanEventInputT[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      errors.push({ line: i + 1, message: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    const parsed = SpanEventInput.safeParse(json);
    if (!parsed.success) {
      errors.push({ line: i + 1, message: parsed.error.issues.map((x) => x.message).join('; ') });
      continue;
    }
    events.push(parsed.data);
  }
  return { events, errors };
}

/** Serialise events back to NDJSON (used by the sample generator). */
export function toNdjson(events: readonly SpanEventInputT[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}
