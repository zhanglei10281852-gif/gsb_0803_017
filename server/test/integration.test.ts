import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LedgerEntryV1, ReplayViewV1, SpanEventV1, WsServerMessageV1 } from "@replay/shared";
import { generateSample } from "../../sample/src/generator.js";

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
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join("server", "src", "index.ts"), "--port", String(port), "--db", dbPath],
    { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.on("data", (d: Buffer) => {
    if (process.env.DEBUG_REPLAY) process.stderr.write(d);
  });
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([exited, timeout]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // 尚未就绪
    }
    if (Date.now() > deadline) throw new Error("服务端启动超时");
    await new Promise((r) => setTimeout(r, 300));
  }
}

interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: Array<{ line: number; error: string }>;
}

async function postNdjson(port: number, events: readonly SpanEventV1[]): Promise<IngestResponse> {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const res = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body,
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as IngestResponse;
}

describe("服务端集成（真实子进程 + 真实 HTTP/WS）", () => {
  const plan = generateSample("gsb-017");
  let dbDir = "";
  let dbPath = "";
  let port = 0;
  let child: ChildProcess | null = null;
  let replayAtHeadBeforeRestart = "";

  beforeAll(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-it-"));
    dbPath = path.join(dbDir, "it.db");
    port = await freePort();
    child = startServer(port, dbPath);
    await waitHealthy(port);
  }, 60_000);

  afterAll(async () => {
    if (child) await stopServer(child);
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("NDJSON 真实网络接入：接受数=唯一事件数，重发全部幂等去重", async () => {
    const events = plan.sends.map((s) => s.event);
    // 分三批 POST，模拟持续到达
    const third = Math.ceil(events.length / 3);
    let accepted = 0;
    let duplicates = 0;
    for (let i = 0; i < events.length; i += third) {
      const r = await postNdjson(port, events.slice(i, i + third));
      accepted += r.accepted;
      duplicates += r.duplicates;
      expect(r.rejected).toHaveLength(0);
    }
    expect(accepted).toBe(plan.stats.uniqueEvents);
    expect(duplicates).toBe(plan.stats.duplicateSends);

    const head = (await (await fetch(`http://127.0.0.1:${port}/api/head`)).json()) as {
      totalEntries: number;
      cursor: { ingestSequence: number };
    };
    expect(head.totalEntries).toBe(plan.stats.uniqueEvents);
    expect(head.cursor.ingestSequence).toBe(plan.stats.uniqueEvents);
  });

  it("游标回放可重复：迟到修订只在 ingest 坐标推进后生效", async () => {
    const ledger = (await (
      await fetch(`http://127.0.0.1:${port}/api/ledger?since=0`)
    ).json()) as { entries: LedgerEntryV1[] };
    const incident = plan.stats.incidentSpans[0];
    expect(incident).toBeDefined();
    if (!incident) return;
    const versions = ledger.entries
      .filter((e) => e.event.traceId === incident.traceId && e.event.spanId === incident.spanId)
      .sort((a, b) => a.event.revision - b.event.revision);
    const r1 = versions.find((v) => v.event.revision === 1);
    const r2 = versions.find((v) => v.event.revision === 2);
    expect(r1 && r2).toBeTruthy();
    if (!r1 || !r2) return;
    const maxTime = plan.baseTimeMs + plan.durationMs + 60_000;

    const replay = async (seq: number): Promise<ReplayViewV1> =>
      (await (
        await fetch(`http://127.0.0.1:${port}/api/replay?eventTime=${maxTime}&ingestSequence=${seq}`)
      ).json()) as ReplayViewV1;

    const before = await replay(r2.ingestSequence - 1);
    const spanBefore = before.spans.find((s) => s.spanId === incident.spanId);
    expect(spanBefore?.revision).toBe(1);
    expect(spanBefore?.status).toBe("ok");

    const after = await replay(r2.ingestSequence);
    const spanAfter = after.spans.find((s) => s.spanId === incident.spanId);
    expect(spanAfter?.revision).toBe(2);
    expect(spanAfter?.status).toBe("error");

    // 同一游标重复请求结果完全一致（可复盘）
    const again = await replay(r2.ingestSequence - 1);
    expect(JSON.stringify(again)).toBe(JSON.stringify(before));

    // span 版本生效理由
    const history = (await (
      await fetch(
        `http://127.0.0.1:${port}/api/span/${incident.traceId}/${incident.spanId}?eventTime=${maxTime}&ingestSequence=${r2.ingestSequence - 1}`,
      )
    ).json()) as { versions: Array<{ revision: number; role: string; reason: string }> };
    const v1 = history.versions.find((v) => v.revision === 1);
    const v2 = history.versions.find((v) => v.revision === 2);
    expect(v1?.role).toBe("current");
    expect(v2?.role).toBe("beyond-cursor");

    replayAtHeadBeforeRestart = JSON.stringify(await replay(Number.MAX_SAFE_INTEGER));
  });

  it("WS 断线重连补发：since=0 收齐全量，随后实时收到新条目", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?since=0`);
    const messages: WsServerMessageV1[] = [];
    let entryCount = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS 补发超时")), 20_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as WsServerMessageV1;
        messages.push(msg);
        if (msg.kind === "entry") entryCount += 1;
        if (msg.kind === "live") {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("error", reject);
    });
    expect(entryCount).toBe(plan.stats.uniqueEvents);

    // 实时推送：再 POST 一条新事件
    const probe: SpanEventV1 = {
      contract: "span-event/1",
      producerId: "it-probe",
      eventId: "probe-1",
      traceId: "tr-probe",
      spanId: "sp-probe",
      parentSpanId: null,
      service: "probe",
      operation: "op",
      eventTime: plan.baseTimeMs + 1_000,
      durationMs: 5,
      revision: 1,
      status: "ok",
      errorMessage: null,
      attributes: {},
    };
    const liveEntry = new Promise<LedgerEntryV1>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("实时推送超时")), 10_000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as WsServerMessageV1;
        if (msg.kind === "entry" && msg.entry.event.eventId === "probe-1") {
          clearTimeout(timer);
          resolve(msg.entry);
        }
      });
    });
    await postNdjson(port, [probe]);
    const received = await liveEntry;
    expect(received.event.traceId).toBe("tr-probe");
    expect(received.ingestSequence).toBe(plan.stats.uniqueEvents + 1);
    ws.close();
  });

  it("投影可重建且与增量维护一致", async () => {
    const report = (await (
      await fetch(`http://127.0.0.1:${port}/api/admin/rebuild`, { method: "POST" })
    ).json()) as { match: boolean };
    expect(report.match).toBe(true);
  });

  it("进程重启后从 SQLite 恢复：head 与任意游标视图不变，无需重新灌入", async () => {
    expect(child).toBeTruthy();
    if (child) await stopServer(child);
    child = startServer(port, dbPath);
    await waitHealthy(port);

    const head = (await (await fetch(`http://127.0.0.1:${port}/api/head`)).json()) as {
      totalEntries: number;
    };
    expect(head.totalEntries).toBe(plan.stats.uniqueEvents + 1); // 含 probe

    const maxTime = plan.baseTimeMs + plan.durationMs + 60_000;
    const replay = await fetch(
      `http://127.0.0.1:${port}/api/replay?eventTime=${maxTime}&ingestSequence=${Number.MAX_SAFE_INTEGER}`,
    );
    const view = (await replay.json()) as ReplayViewV1;
    const beforeView = JSON.parse(replayAtHeadBeforeRestart) as ReplayViewV1;
    // probe 事件 eventTime 在窗口内，重启后视图应比重启前多 1 个可见 span
    expect(view.totals.entries).toBe(beforeView.totals.entries + 1);
    expect(
      view.spans.filter((s) => s.traceId !== "tr-probe"),
    ).toEqual(beforeView.spans.filter((s) => s.traceId !== "tr-probe"));
  });
});
