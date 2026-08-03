import { describe, it, expect } from 'vitest';
import { buildScript, mulberry32 } from '../../src/sample/script';
import { parseNdjson, toNdjson } from '../../src/shared/ndjson';

describe('sample script determinism', () => {
  it('produces identical output for the same seed', () => {
    const a = buildScript(1).map((s) => s.event);
    const b = buildScript(1).map((s) => s.event);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('produces different ordering for different seeds', () => {
    const a = buildScript(1).map((s) => s.event.spanId);
    const b = buildScript(999).map((s) => s.event.spanId);
    expect(a.join(',')).not.toEqual(b.join(','));
  });

  it('includes a duplicate and a revision', () => {
    const script = buildScript(1);
    expect(script.some((s) => s.isDuplicate)).toBe(true);
    expect(script.some((s) => s.isRevision)).toBe(true);
  });

  it('mulberry32 is deterministic', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe('ndjson round-trip', () => {
  it('parses what it serialises', () => {
    const events = buildScript(1).map((s) => s.event);
    const text = toNdjson(events);
    const { events: parsed, errors } = parseNdjson(text);
    expect(errors).toHaveLength(0);
    expect(parsed).toHaveLength(events.length);
  });

  it('collects invalid lines without dropping valid ones', () => {
    const good = toNdjson([buildScript(1)[0]!.event]).trim();
    const body = `${good}\nnot-json\n{"contractVersion":1}`;
    const { events, errors } = parseNdjson(body);
    expect(events).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
