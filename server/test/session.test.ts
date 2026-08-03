import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  InvestigationSessionV1,
  SealResponseV1,
  SpanEventV1,
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

function ev(spanId: string, eventTime: number, overrides: Partial<SpanEventV1> = {}): SpanEventV1 {
  return {
    contract: "span-event/1",
    producerId: "ses-it",
    eventId: `e-${spanId}-${eventTime}-${Math.random().toString(36).slice(2, 8)}`,
    traceId: "t1",
    spanId,
    parentSpanId: null,
    service: "svc",
    operation: "op",
    eventTime,
    durationMs: 10,
    revision: 1,
    status: "ok",
    errorMessage: null,
    attributes: {},
    ...overrides,
  };
}

const cursorOf = (ingestSequence: number) => ({
  contract: "replay-cursor/1" as const,
  eventTime: 9999,
  ingestSequence,
});

interface ApiOpts {
  method?: string;
  body?: unknown;
}

async function api<T>(port: number, path_: string, opts: ApiOpts = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path_}`, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

describe("InvestigationSession（真实子进程：租约/fencing/归并/重启持久化）", () => {
  let dbDir = "";
  let dbPath = "";
  let port = 0;
  let child: ChildProcess | null = null;
  let snapshotId = "";
  let sessionId = "";

  beforeAll(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-ses-"));
    dbPath = path.join(dbDir, "ses.db");
    port = await freePort();
    child = startServer(port, dbPath);
    await waitHealthy(port);
    // 灌入基础账本并封存一个锚点快照
    await api(port, "/api/ingest", {
      method: "POST",
      body: undefined,
    }).catch(() => undefined);
    await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: [ev("root", 1000), ev("pay", 1010, { parentSpanId: "root", service: "payments" })]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    });
    const seal = await api<SealResponseV1>(port, "/api/snapshots", {
      method: "POST",
      body: { contract: "seal-request/1", cursorA: cursorOf(1), cursorB: cursorOf(2), label: "交接锚点" },
    });
    expect(seal.status).toBe(201);
    snapshotId = seal.json.snapshot.id;
  }, 60_000);

  afterAll(async () => {
    if (child) await stopServer(child);
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("以快照标识与摘要为锚点创建会话", async () => {
    const r = await api<InvestigationSessionV1>(port, "/api/sessions", {
      method: "POST",
      body: { snapshotId, clientId: "c-a", name: "班组-A" },
    });
    expect(r.status).toBe(201);
    sessionId = r.json.sessionId;
    expect(r.json.anchorSnapshotId).toBe(snapshotId);
    expect(r.json.anchorDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.sharedCursor).toEqual(cursorOf(2));
    expect(r.json.participants.map((p) => p.name)).toEqual(["班组-A"]);
  });

  it("无租约时门控操作被拒绝；授租后 fencing token 生效", async () => {
    const noLease = await api<{ error: string }>(port, `/api/sessions/${sessionId}/cursor`, {
      method: "POST",
      body: { clientId: "c-a", fencingToken: 1, cursor: cursorOf(1) },
    });
    expect(noLease.status).toBe(409);
    expect(noLease.json.error).toBe("no-valid-lease");

    const acquired = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}/lease`, {
      method: "POST",
      body: { clientId: "c-a", name: "班组-A", ttlMs: 60_000 },
    });
    expect(acquired.status).toBe(200);
    expect(acquired.json.lease?.holderId).toBe("c-a");
    expect(acquired.json.lease?.fencingToken).toBe(1);

    // 他人持租时获取失败
    const held = await api<{ error: string }>(port, `/api/sessions/${sessionId}/lease`, {
      method: "POST",
      body: { clientId: "c-b", name: "班组-B", ttlMs: 60_000 },
    });
    expect(held.status).toBe(409);
    expect(held.json.error).toBe("lease-held");

    // 错误 token / 错误持有者均被拒
    const wrongToken = await api<{ error: string }>(port, `/api/sessions/${sessionId}/cursor`, {
      method: "POST",
      body: { clientId: "c-a", fencingToken: 99, cursor: cursorOf(1) },
    });
    expect(wrongToken.status).toBe(409);
    expect(wrongToken.json.error).toBe("stale-fencing-token");

    const ok = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}/cursor`, {
      method: "POST",
      body: { clientId: "c-a", fencingToken: 1, cursor: cursorOf(1) },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.sharedCursor).toEqual(cursorOf(1));
  });

  it("会话内封存需有效租约，快照挂到会话下", async () => {
    const denied = await api<{ error: string }>(port, `/api/sessions/${sessionId}/seal`, {
      method: "POST",
      body: { clientId: "c-b", fencingToken: 1, cursorA: cursorOf(1), cursorB: cursorOf(2), label: null },
    });
    expect(denied.status).toBe(409);

    const sealed = await api<SealResponseV1>(port, `/api/sessions/${sessionId}/seal`, {
      method: "POST",
      body: { clientId: "c-a", fencingToken: 1, cursorA: cursorOf(0), cursorB: cursorOf(2), label: "会话快照" },
    });
    expect(sealed.status).toBe(201);
    const state = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    expect(state.json.snapshotIds).toContain(sealed.json.snapshot.id);
  });

  it("并发备注确定性归并：与到达顺序无关，归并摘要稳定", async () => {
    // 先到的请求带更晚的 createdAtMs，后到的请求带更早的 createdAtMs
    const late = api(port, `/api/sessions/${sessionId}/notes`, {
      method: "POST",
      body: { clientId: "c-a", author: "班组-A", text: "晚到的备注", noteId: "n-late", createdAtMs: 2000 },
    });
    const early = api(port, `/api/sessions/${sessionId}/notes`, {
      method: "POST",
      body: { clientId: "c-b", author: "班组-B", text: "早先的备注", noteId: "n-early", createdAtMs: 1000 },
    });
    await Promise.all([late, early]);
    // 再补一条同 createdAtMs 的，验证 clientId 次序参与归并
    await api(port, `/api/sessions/${sessionId}/notes`, {
      method: "POST",
      body: { clientId: "c-a", author: "班组-A", text: "同时刻 A", noteId: "n-same-a", createdAtMs: 1500 },
    });
    await api(port, `/api/sessions/${sessionId}/notes`, {
      method: "POST",
      body: { clientId: "c-b", author: "班组-B", text: "同时刻 B", noteId: "n-same-b", createdAtMs: 1500 },
    });

    const s1 = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    const s2 = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    expect(s1.json.mergeDigest).toBe(s2.json.mergeDigest);
    expect(s1.json.notes.map((n) => n.noteId)).toEqual(["n-early", "n-same-a", "n-same-b", "n-late"]);
    // 客户端重试幂等
    await api(port, `/api/sessions/${sessionId}/notes`, {
      method: "POST",
      body: { clientId: "c-b", author: "班组-B", text: "早先的备注", noteId: "n-early", createdAtMs: 1000 },
    });
    const s3 = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    expect(s3.json.notes).toHaveLength(4);
    expect(s3.json.mergeDigest).toBe(s1.json.mergeDigest);
  });

  it("服务重启后：会话、租约、fencing token 与归并结果继续成立", async () => {
    const before = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    if (child) await stopServer(child);
    child = startServer(port, dbPath);
    await waitHealthy(port);

    const after = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    expect(after.json.anchorDigest).toBe(before.json.anchorDigest);
    expect(after.json.lease?.holderId).toBe("c-a");
    expect(after.json.lease?.fencingToken).toBe(1);
    expect(after.json.mergeDigest).toBe(before.json.mergeDigest);
    expect(after.json.notes.map((n) => n.noteId)).toEqual(before.json.notes.map((n) => n.noteId));

    // 租约仍有效：原持有者凭原 token 继续推进共同游标
    const push = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}/cursor`, {
      method: "POST",
      body: { clientId: "c-a", fencingToken: 1, cursor: cursorOf(2) },
    });
    expect(push.status).toBe(200);
  });

  it("租约过期后新负责人接管；旧客户端晚到的过期 token 不能覆盖", async () => {
    // 租一个 3s 的短租约（同一持有者重新获取 → token 递增到 2）
    const short = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}/lease`, {
      method: "POST",
      body: { clientId: "c-a", name: "班组-A", ttlMs: 3_000 },
    });
    expect(short.json.lease?.fencingToken).toBe(2);
    await new Promise((r) => setTimeout(r, 3_600));

    const takeover = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}/lease`, {
      method: "POST",
      body: { clientId: "c-b", name: "班组-B", ttlMs: 60_000 },
    });
    expect(takeover.status).toBe(200);
    expect(takeover.json.lease?.holderId).toBe("c-b");
    expect(takeover.json.lease?.fencingToken).toBe(3);

    // 旧负责人晚到的请求携带过期 token → 拒绝，共同游标不被覆盖
    const stale = await api<{ error: string }>(port, `/api/sessions/${sessionId}/cursor`, {
      method: "POST",
      body: { clientId: "c-a", fencingToken: 2, cursor: cursorOf(1) },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("stale-fencing-token");
    const state = await api<InvestigationSessionV1>(port, `/api/sessions/${sessionId}`);
    expect(state.json.sharedCursor).toEqual(cursorOf(2));
    expect(state.json.lease?.holderId).toBe("c-b");
  });
});
