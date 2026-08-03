import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  IncidentSnapshotV1,
  SealResponseV1,
  SnapshotDetailV1,
  SnapshotListV1,
  SpanEventV1,
  VerifyReportV1,
} from "@replay/shared";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function startServer(port: number, dbPath: string): ChildProcess {
  return spawn(
    process.execPath,
    ["--import", "tsx", path.join("server", "src", "index.ts"), "--port", String(port), "--db", dbPath],
    { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // 等待就绪
    }
    if (Date.now() > deadline) throw new Error("服务端启动超时");
    await new Promise((r) => setTimeout(r, 300));
  }
}

let n = 0;
function ev(overrides: Partial<SpanEventV1>): SpanEventV1 {
  n += 1;
  return {
    contract: "span-event/1",
    producerId: "snap-it",
    eventId: `e-${n}`,
    traceId: "t1",
    spanId: "root",
    parentSpanId: null,
    service: "gateway",
    operation: "op",
    eventTime: 1000,
    durationMs: 20,
    revision: 1,
    status: "ok",
    errorMessage: null,
    attributes: {},
    ...overrides,
  };
}

const EVENTS: SpanEventV1[] = [
  ev({ spanId: "root", service: "gateway" }), // seq 1
  ev({ spanId: "pay", parentSpanId: "root", service: "payments", eventTime: 1010 }), // seq 2
  ev({ spanId: "pay", parentSpanId: "root", service: "payments", eventTime: 1010, revision: 2, status: "error", errorMessage: "timeout" }), // seq 3
  ev({ spanId: "auth", parentSpanId: "root", service: "auth", eventTime: 1020 }), // seq 4
];
const LATE = ev({ spanId: "late", parentSpanId: "root", service: "notify", eventTime: 1005 }); // seq 5，eventTime 在过去

const T = 5000;
const cursorA = { contract: "replay-cursor/1", eventTime: T, ingestSequence: 2 } as const;
const cursorB = { contract: "replay-cursor/1", eventTime: T, ingestSequence: 4 } as const;

async function seal(port: number, a: typeof cursorA, b: typeof cursorA): Promise<SealResponseV1> {
  const res = await fetch(`http://127.0.0.1:${port}/api/snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract: "seal-request/1", cursorA: a, cursorB: b, label: "事故复盘" }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as SealResponseV1;
}

describe("IncidentSnapshot（真实子进程：重启后同一摘要，迟到不改写）", () => {
  let dbDir = "";
  let dbPath = "";
  let port = 0;
  let child: ChildProcess | null = null;
  let snapshotId = "";
  let sealedDigest = "";

  beforeAll(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-snap-"));
    dbPath = path.join(dbDir, "snap.db");
    port = await freePort();
    child = startServer(port, dbPath);
    await waitHealthy(port);
    await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  }, 60_000);

  afterAll(async () => {
    if (child) await stopServer(child);
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("封存 A/B：差异、摘要与高水位正确", async () => {
    const r = await seal(port, cursorA, cursorB);
    expect(r.existing).toBe(false);
    const s = r.snapshot;
    snapshotId = s.id;
    sealedDigest = s.digest;
    expect(s.id).toMatch(/^snap-[0-9a-f]{16}$/);
    expect(s.highWater.totalEntries).toBe(4);
    expect(s.highWater.ingestSequence).toBe(4);
    expect(s.diff.summary.added).toBe(1); // auth 出现
    expect(s.diff.summary.changed).toBe(1); // pay r1→r2
    expect(s.diff.summary.statusFlips).toBe(1);
    expect(s.diff.summary.edgesChanged).toBe(1); // gateway→payments 错误数 0→1
    expect(s.diff.errorPathChanges[0]?.gainedSpanIds).toEqual(["pay"]);
  });

  it("相同游标重复封存：幂等返回同一快照", async () => {
    const r = await seal(port, cursorA, cursorB);
    expect(r.existing).toBe(true);
    expect(r.snapshot.id).toBe(snapshotId);
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/snapshots`)).json()) as SnapshotListV1;
    expect(list.items).toHaveLength(1);
  });

  it("备注只追加且可持久化", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/snapshots/${snapshotId}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "值班-张", text: "payments r2 为迟到修订，确认告警延迟根因" }),
    });
    expect(res.status).toBe(201);
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/api/snapshots/${snapshotId}`)
    ).json()) as SnapshotDetailV1;
    expect(detail.snapshot.notes).toHaveLength(1);
    expect(detail.snapshot.notes[0]?.author).toBe("值班-张");
    expect(detail.verify.match).toBe(true);
  });

  it("进程重启后：相同账本与游标得到同一摘要", async () => {
    if (child) await stopServer(child);
    child = startServer(port, dbPath);
    await waitHealthy(port);
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/api/snapshots/${snapshotId}`)
    ).json()) as SnapshotDetailV1;
    expect(detail.snapshot.digest).toBe(sealedDigest);
    expect(detail.verify.digest).toBe(sealedDigest);
    expect(detail.verify.recomputed).toBe(sealedDigest);
    expect(detail.verify.match).toBe(true);
    // 备注随重启保留
    expect(detail.snapshot.notes).toHaveLength(1);
  });

  it("迟到事件进入账本后：已封存摘要不变，新游标可产生新快照", async () => {
    await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: JSON.stringify(LATE) + "\n",
    });
    const verify = (await (
      await fetch(`http://127.0.0.1:${port}/api/snapshots/${snapshotId}/verify`)
    ).json()) as VerifyReportV1;
    expect(verify.match).toBe(true);
    expect(verify.digest).toBe(sealedDigest);
    expect(verify.checkedEntries).toBe(5);

    // 相同游标仍幂等
    const again = await seal(port, cursorA, cursorB);
    expect(again.existing).toBe(true);
    expect(again.snapshot.id).toBe(snapshotId);

    // 推进 B 的 ingest 坐标 → 新摘要、新快照（迟到事件可见为新增 span）
    const r2 = await seal(port, cursorA, { ...cursorB, ingestSequence: 5 });
    expect(r2.existing).toBe(false);
    expect(r2.snapshot.id).not.toBe(snapshotId);
    expect(r2.snapshot.diff.summary.added).toBe(2); // auth + late
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/snapshots`)).json()) as SnapshotListV1;
    expect(list.items).toHaveLength(2);
  });
});
