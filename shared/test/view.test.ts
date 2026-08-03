import { describe, expect, it } from "vitest";
import {
  buildView,
  causalPath,
  cursorOf,
  explainSpanVersions,
  parseSpanEvent,
  parseSpanEventLine,
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

describe("契约解析", () => {
  it("接受合法事件并补齐默认值", () => {
    const r = parseSpanEvent({
      contract: "span-event/1",
      producerId: "p",
      eventId: "e",
      traceId: "t",
      spanId: "s",
      service: "svc",
      operation: "op",
      eventTime: 1,
      durationMs: 2,
      revision: 1,
      status: "ok",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.parentSpanId).toBeNull();
      expect(r.value.errorMessage).toBeNull();
      expect(r.value.attributes).toEqual({});
    }
  });

  it("拒绝非法契约与非法字段", () => {
    expect(parseSpanEventLine("not json").ok).toBe(false);
    expect(parseSpanEvent({ contract: "span-event/2" }).ok).toBe(false);
    expect(
      parseSpanEvent({
        contract: "span-event/1",
        producerId: "p",
        eventId: "e",
        traceId: "t",
        spanId: "s",
        service: "svc",
        operation: "op",
        eventTime: 1,
        durationMs: 2,
        revision: 0,
        status: "ok",
      }).ok,
    ).toBe(false);
    expect(
      parseSpanEvent({
        contract: "span-event/1",
        producerId: "p",
        eventId: "e",
        traceId: "t",
        spanId: "s",
        service: "svc",
        operation: "op",
        eventTime: 1,
        durationMs: 2,
        revision: 1,
        status: "broken",
      }).ok,
    ).toBe(false);
  });
});

describe("buildView 游标确定性", () => {
  const entries: LedgerEntryV1[] = [
    entry({ spanId: "root", service: "gateway", eventTime: 1000 }, 1),
    entry({ spanId: "pay", parentSpanId: "root", service: "payments", eventTime: 1010, revision: 1 }, 2),
    entry({ spanId: "pay", parentSpanId: "root", service: "payments", eventTime: 1010, revision: 2, status: "error", errorMessage: "timeout" }, 5),
    entry({ spanId: "late", parentSpanId: "root", service: "auth", eventTime: 1005 }, 9),
  ];

  it("游标固定时视图与条目到达顺序无关", () => {
    const cursor = cursorOf(2000, 99);
    const baseline = JSON.stringify(buildView(entries, cursor));
    let arr = [...entries];
    for (let seed = 1; seed <= 40; seed++) {
      // 简单可重复洗牌
      arr = arr
        .map((v) => ({ v, k: Math.sin(seed * 9973 + v.ingestSequence * 131) }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.v);
      expect(JSON.stringify(buildView(arr, cursor))).toBe(baseline);
    }
  });

  it("回拨 ingest 坐标后迟到修订不生效，推进后生效", () => {
    const before = buildView(entries, cursorOf(2000, 4));
    const pay1 = before.spans.find((s) => s.spanId === "pay");
    expect(pay1?.revision).toBe(1);
    expect(pay1?.status).toBe("ok");

    const after = buildView(entries, cursorOf(2000, 5));
    const pay2 = after.spans.find((s) => s.spanId === "pay");
    expect(pay2?.revision).toBe(2);
    expect(pay2?.status).toBe("error");
  });

  it("回拨 eventTime 坐标后晚到事件不可见，并统计迟到计数", () => {
    const v = buildView(entries, cursorOf(1006, 99));
    expect(v.spans.find((s) => s.spanId === "pay")).toBeUndefined();
    expect(v.spans.find((s) => s.spanId === "late")).toBeDefined();
  });

  it("暂停游标之后的到达计入 lateArrivals，写入过去的单独计数", () => {
    const v = buildView(entries, cursorOf(2000, 2));
    expect(v.totals.lateArrivalsBeyondCursor).toBe(2); // ingest 5 与 9
    expect(v.totals.lateArrivalsIntoPast).toBe(2); // 两者 eventTime 都 <= 2000
    const v2 = buildView(entries, cursorOf(1004, 2));
    expect(v2.totals.lateArrivalsIntoPast).toBe(0);
  });

  it("跨服务边与因果链聚合正确", () => {
    const v = buildView(entries, cursorOf(2000, 99));
    const edge = v.edges.find((e) => e.fromService === "gateway" && e.toService === "payments");
    expect(edge?.callCount).toBe(1);
    expect(edge?.errorCount).toBe(1);
    const path = causalPath(v.spans, "t1", "pay");
    expect(path.chain.map((s) => s.spanId)).toEqual(["root", "pay"]);
    expect(path.errorSpanIds).toEqual(["pay"]);
  });
});

describe("explainSpanVersions 生效理由", () => {
  const versions: LedgerEntryV1[] = [
    entry({ spanId: "x", revision: 1, eventTime: 1000 }, 3),
    entry({ spanId: "x", revision: 2, eventTime: 1000 }, 4),
    entry({ spanId: "x", revision: 3, eventTime: 1000, status: "error" }, 8),
    entry({ spanId: "x", revision: 2, eventTime: 1000 }, 10), // 迟到旧修订
  ];

  it("当前/被取代/迟到旧修订/游标外 四种角色", () => {
    const h = explainSpanVersions(versions, "t1", "x", cursorOf(2000, 8));
    const byRole = new Map(h.versions.map((v) => [`${v.revision}@${v.ingestSequence}`, v]));
    expect(h.currentRevision).toBe(3);
    expect(byRole.get("3@8")?.role).toBe("current");
    expect(byRole.get("3@8")?.reason).toContain("最高修订");
    expect(byRole.get("2@4")?.role).toBe("superseded");
    expect(byRole.get("1@3")?.role).toBe("superseded");
    expect(byRole.get("2@10")?.role).toBe("beyond-cursor");
    expect(byRole.get("2@10")?.reason).toContain("游标");
  });

  it("迟到旧修订：到达时已存在更高修订", () => {
    const late: LedgerEntryV1[] = [
      entry({ spanId: "y", revision: 3, eventTime: 1000 }, 5),
      entry({ spanId: "y", revision: 1, eventTime: 1000 }, 9),
    ];
    const h = explainSpanVersions(late, "t1", "y", cursorOf(2000, 99));
    const stale = h.versions.find((v) => v.ingestSequence === 9);
    expect(stale?.role).toBe("stale-on-arrival");
    expect(stale?.reason).toContain("从未生效");
  });

  it("同修订重复投递：取 ingest 最小者", () => {
    const dup: LedgerEntryV1[] = [
      entry({ spanId: "z", revision: 2, eventTime: 1000 }, 5),
      entry({ spanId: "z", revision: 2, eventTime: 1000 }, 7),
    ];
    const h = explainSpanVersions(dup, "t1", "z", cursorOf(2000, 99));
    expect(h.versions.find((v) => v.ingestSequence === 5)?.role).toBe("current");
    expect(h.versions.find((v) => v.ingestSequence === 7)?.role).toBe("superseded");
  });
});
