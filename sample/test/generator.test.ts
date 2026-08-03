import { describe, expect, it } from "vitest";
import { generateSample, planToNdjson } from "../src/generator.js";

describe("确定性样例流", () => {
  it("同一种子生成完全一致的计划", () => {
    const a = generateSample("gsb-017");
    const b = generateSample("gsb-017");
    expect(planToNdjson(a)).toBe(planToNdjson(b));
    expect(a.stats).toEqual(b.stats);
  });

  it("统计与发送计划自洽", () => {
    const plan = generateSample("gsb-017");
    const keys = new Set(plan.sends.map((s) => `${s.event.producerId}/${s.event.eventId}`));
    expect(keys.size).toBe(plan.stats.uniqueEvents);
    expect(plan.stats.totalSends).toBe(plan.sends.length);
    expect(plan.stats.duplicateSends).toBe(plan.sends.length - keys.size);
    expect(plan.stats.duplicateSends).toBeGreaterThan(0);
  });

  it("包含乱序、重复、修订与断线重连", () => {
    const plan = generateSample("gsb-017");
    expect(plan.stats.outOfOrderPairs).toBeGreaterThan(0);
    expect(plan.stats.revisedSpanCount).toBeGreaterThan(0);
    expect(plan.stats.reconnect.resentCount).toBe(25);
    expect(plan.sends.some((s) => s.kind === "duplicate")).toBe(true);
    expect(plan.sends.filter((s) => s.kind === "reconnect-resend")).toHaveLength(25);
    // 重连窗口内该 producer 无发送
    const gapStart = plan.baseTimeMs + plan.stats.reconnect.gapStartOffsetMs;
    const gapEnd = plan.baseTimeMs + plan.stats.reconnect.gapEndOffsetMs;
    const inGap = plan.sends.filter(
      (s) => s.event.producerId === "collector-pay" && s.sendAtMs >= gapStart && s.sendAtMs < gapEnd,
    );
    expect(inGap).toHaveLength(0);
  });

  it("事故 span 最终为 r2 error，且存在更高的迟到修订", () => {
    const plan = generateSample("gsb-017");
    expect(plan.stats.incidentSpans.length).toBeGreaterThan(10);
    const target = plan.stats.incidentSpans[0];
    expect(target).toBeDefined();
    if (!target) return;
    const versions = plan.sends.filter(
      (s) => s.event.traceId === target.traceId && s.event.spanId === target.spanId,
    );
    const revisions = [...new Set(versions.map((v) => v.event.revision))].sort();
    expect(revisions).toEqual([1, 2]);
    const r1 = versions.find((v) => v.event.revision === 1);
    const r2 = versions.find((v) => v.event.revision === 2);
    expect(r1 && r2 && r2.sendAtMs > r1.sendAtMs).toBe(true);
    expect(r2?.event.status).toBe("error");
  });
});
