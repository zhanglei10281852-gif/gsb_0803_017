import { parseRawSpanEvent, type RawSpanEvent } from '../shared/contracts.js';

export interface ParsedIngest {
  events: RawSpanEvent[];
  errors: string[];
}

export function parseNdjsonBody(text: string): ParsedIngest {
  const events: RawSpanEvent[] = [];
  const errors: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { events, errors };
  }

  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      errors.push(`invalid JSON array: ${(e as Error).message}`);
      return { events, errors };
    }
    if (!Array.isArray(arr)) {
      errors.push('expected a JSON array or NDJSON');
      return { events, errors };
    }
    arr.forEach((item, idx) => {
      try {
        events.push(parseRawSpanEvent(item));
      } catch (e) {
        errors.push(`record[${idx}]: ${(e as Error).message}`);
      }
    });
    return { events, errors };
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const t = line.trim();
    if (t.length === 0) return;
    try {
      const obj = JSON.parse(t) as unknown;
      events.push(parseRawSpanEvent(obj));
    } catch (e) {
      errors.push(`line ${idx + 1}: ${(e as Error).message}`);
    }
  });
  return { events, errors };
}
