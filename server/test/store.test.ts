import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpanEventV1 } from "@replay/shared";
import { ReplayStore } from "../src/store.js";

const tmpDirs: string[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-store-"));
  tmpDirs.push(dir);
  return path.join(dir, "test.db");
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

let n = 0;
function ev(overrides: Partial<SpanEventV1>): SpanEventV1 {
  n += 1;
  return {
    contract: "span-event/1",
    producerId: "p1",
    eventId: `e-${n}`,
    traceId: "t1",
    spanId: "s1",
    parentSpanId: null,
    service: "svc",
    operation: "op",
    eventTime: 1000,
    durationMs: 10,
    revision: 1,
    status: "ok",
    errorMessage: null,
    attributes: {},
    ...overrides,
  };
}

describe("ReplayStore", () => {
  it("ingestSequence 单调且连续；重复 (producerId, eventId) 幂等去重", () => {
    const store = new ReplayStore(tmpDb());
    const a = ev({ eventId: "dup-1", spanId: "a" });
    const r1 = store.ingestBatch([a, ev({ spanId: "b" }), a]);
    expect(r1.accepted).toHaveLength(2);
    expect(r1.receipts.map((r) => r.outcome)).toEqual(["accepted", "accepted", "duplicate"]);
    expect(r1.receipts[2]?.ingestSequence).toBe(r1.receipts[0]?.ingestSequence);
    expect(r1.accepted.map((e) => e.ingestSequence)).toEqual([1, 2]);

    const r2 = store.ingestBatch([ev({ spanId: "c" })]);
    expect(r2.accepted[0]?.ingestSequence).toBe(3);
    expect(store.head().totalEntries).toBe(3);
    store.close();
  });

  it("最高 revision 生效；投影校验与账本重建一致", () => {
    const store = new ReplayStore(tmpDb());
    store.ingestBatch([ev({ spanId: "x", revision: 1 })]);
    store.ingestBatch([ev({ spanId: "x", revision: 3, status: "error" })]);
    store.ingestBatch([ev({ spanId: "x", revision: 2 })]); // 旧修订迟到，仅入账
    expect(store.head().totalEntries).toBe(3);
    const versions = store.spanVersions("t1", "x");
    expect(versions.map((v) => v.event.revision)).toEqual([1, 3, 2]);

    const before = store.projectionChecksum();
    const rebuilt = store.rebuildProjection();
    expect(before).toBe(rebuilt.checksum);
    store.close();
  });

  it("关闭后重开同一文件：无需重新灌入即可恢复", () => {
    const db = tmpDb();
    const s1 = new ReplayStore(db);
    s1.ingestBatch([ev({ spanId: "a" }), ev({ spanId: "b", eventTime: 2000 })]);
    const head1 = s1.head();
    s1.close();

    const s2 = new ReplayStore(db);
    const head2 = s2.head();
    expect(head2.totalEntries).toBe(head1.totalEntries);
    expect(head2.cursor).toEqual(head1.cursor);
    // 重开后 ingestSequence 继续单调递增
    const r = s2.ingestBatch([ev({ spanId: "c" })]);
    expect(r.accepted[0]?.ingestSequence).toBe(head1.cursor.ingestSequence + 1);
    const verify = s2.verifyProjection();
    expect(verify.ok).toBe(true);
    s2.close();
  });
});
