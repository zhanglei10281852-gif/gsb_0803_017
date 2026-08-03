import { describe, expect, it } from "vitest";
import {
  buildView,
  cursorOf,
  diffViews,
  stableStringify,
  type LedgerEntryV1,
  type SpanEventV1,
} from "../src/index.js";

let seq = 0;
function entry(overrides: Partial<SpanEventV1>, ingest?: number): LedgerEntryV1 {
  seq += 1;
  const base: SpanEventV1 = {
    contract: "span-event/1",
    producerId: "p1",
    eventId: `e-${seq}`,
    traceId: "t1",
    spanId: "s1",
    parentSpanId: null,
    service: "gateway",
    operation: "op",
    eventTime: 1000,
    durationMs: 50,
    revision: 1,
    status: "ok",
    errorMessage: null,
    attributes: {},
  };
  return {
    contract: "ledger-entry/1",
    ingestSequence: ingest ?? seq,
    receivedAtMs: 0,
    event: { ...base, ...overrides },
  };
}

const T = 5000;

function fixture(): LedgerEntryV1[] {
  return [
    entry({ spanId: "root", service: "gateway" }, 1),
    entry({ spanId: "pay", parentSpanId: "root", service: "payments", eventTime: 1010, revision: 1 }, 2),
    entry({ spanId: "pay", parentSpanId: "root", service: "payments", eventTime: 1010, revision: 2, status: "error", errorMessage: "timeout" }, 3),
    entry({ spanId: "auth", parentSpanId: "root", service: "auth", eventTime: 1020 }, 4),
  ];
}

describe("diffViews A/B 差异", () => {
  const entries = fixture();
  const viewA = buildView(entries, cursorOf(T, 2)); // pay 仅 r1，无 auth
  const viewB = buildView(entries, cursorOf(T, 4)); // pay r2 error，auth 出现
  const diff = diffViews(viewA, viewB);

  it("新增 / 变化 / 状态翻转 / 边变化 / 错误路径变化", () => {
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(1);
    expect(diff.summary.statusFlips).toBe(1);

    const added = diff.spanChanges.find((c) => c.kind === "added");
    expect(added?.spanId).toBe("auth");
    expect(added?.before).toBeNull();

    const changed = diff.spanChanges.find((c) => c.kind === "changed");
    expect(changed?.spanId).toBe("pay");
    expect(changed?.changes.join(" ")).toContain("状态 ok → error");
    expect(changed?.changes.join(" ")).toContain("修订 r1 → r2");

    const edge = diff.edgeChanges.find((e) => e.fromService === "gateway" && e.toService === "payments");
    expect(edge?.kind).toBe("changed");
    expect(edge?.changes.join(" ")).toContain("错误数 0 → 1");

    expect(diff.errorPathChanges).toHaveLength(1);
    expect(diff.errorPathChanges[0]?.gainedSpanIds).toEqual(["pay"]);
  });

  it("相同视图差异为空；视图与差异对输入顺序稳定", () => {
    const empty = diffViews(viewA, viewA);
    expect(empty.summary.added + empty.summary.removed + empty.summary.changed).toBe(0);
    expect(empty.edgeChanges).toHaveLength(0);

    const shuffled = [...fixture()].reverse();
    const viewA2 = buildView(shuffled, cursorOf(T, 2));
    const viewB2 = buildView(shuffled, cursorOf(T, 4));
    expect(stableStringify(diffViews(viewA2, viewB2))).toBe(stableStringify(diff));
  });

  it("消失：B 游标 eventTime 回拨后 span 不可见", () => {
    const earlyB = buildView(entries, cursorOf(1005, 4));
    const d = diffViews(viewB, earlyB);
    expect(d.summary.removed).toBeGreaterThan(0);
    expect(d.spanChanges.every((c) => c.kind === "removed" || c.kind === "changed")).toBe(true);
  });
});

describe("stableStringify 确定性", () => {
  it("与对象键序无关", () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: "x" } })).toBe(
      stableStringify({ a: { c: "x", d: [1, 2] }, b: 1 }),
    );
  });
  it("数组保持顺序", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});
