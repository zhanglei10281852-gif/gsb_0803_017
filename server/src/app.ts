import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
  buildView,
  explainSpanVersions,
  parseCreateSession,
  parseCursorPush,
  parseJoinSession,
  parseLeaseAcquire,
  parseLeaseToken,
  parseNoteInput,
  parseSealRequest,
  parseSessionNote,
  parseSessionSeal,
  parseSpanEventLine,
  CONTRACT_VERSION,
  type GateErrorV1,
  type IngestBatchResultV1,
  type ReplayCursorV1,
  type SealResponseV1,
  type SpanEventV1,
} from "@replay/shared";
import { SessionService, type SessionResult } from "./session.js";
import { computeSnapshot, verifySnapshot } from "./snapshot.js";
import type { ReplayStore } from "./store.js";

export interface AppDeps {
  store: ReplayStore;
  emitter: EventEmitter;
  webDist: string;
}

function parseCursorQuery(req: Request, res: Response): ReplayCursorV1 | null {
  const eventTime = Number(req.query.eventTime);
  const ingestSequence = Number(req.query.ingestSequence);
  if (
    !Number.isFinite(eventTime) ||
    eventTime < 0 ||
    !Number.isInteger(ingestSequence) ||
    ingestSequence < 0
  ) {
    res.status(400).json({
      error: "非法游标参数：需要 eventTime>=0 与整数 ingestSequence>=0",
    });
    return null;
  }
  return { contract: "replay-cursor/1", eventTime, ingestSequence };
}

export function createApp(deps: AppDeps): Express {
  const { store, emitter, webDist } = deps;
  const app = express();
  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => {
    res.json({ contract: "health/1", ok: true });
  });

  app.get("/api/head", (_req, res) => {
    const h = store.head();
    res.json({
      contract: "head/1",
      contractVersion: CONTRACT_VERSION,
      cursor: h.cursor,
      totalEntries: h.totalEntries,
      distinctSpans: h.distinctSpans,
      services: h.services,
    });
  });

  // NDJSON 接入：每行一个 span-event/1；整批事务写入；重复事件幂等去重。
  app.post("/api/ingest", express.text({ type: () => true, limit: "50mb" }), (req, res) => {
    const body = typeof req.body === "string" ? req.body : "";
    const lines = body.split(/\r?\n/);
    const events: SpanEventV1[] = [];
    const rejected: Array<{ line: number; error: string }> = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = parseSpanEventLine(trimmed);
      if (parsed.ok) events.push(parsed.value);
      else rejected.push({ line: idx + 1, error: parsed.error });
    });
    if (events.length === 0 && rejected.length > 0) {
      const result: IngestBatchResultV1 = {
        contract: "ingest-batch/1",
        accepted: 0,
        duplicates: 0,
        rejected,
        receipts: [],
      };
      res.status(400).json(result);
      return;
    }
    const { receipts, accepted } = store.ingestBatch(events);
    for (const e of accepted) emitter.emit("entry", e);
    const result: IngestBatchResultV1 = {
      contract: "ingest-batch/1",
      accepted: accepted.length,
      duplicates: receipts.length - accepted.length,
      rejected,
      receipts,
    };
    res.json(result);
  });

  app.get("/api/ledger", (req, res) => {
    const since = Number(req.query.since ?? 0);
    const limitRaw = Number(req.query.limit ?? 50_000);
    if (!Number.isInteger(since) || since < 0) {
      res.status(400).json({ error: "非法 since 参数" });
      return;
    }
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50_000) : 50_000;
    res.json({
      contract: "ledger-page/1",
      entries: store.entriesSince(since, limit),
      head: store.head().cursor,
    });
  });

  app.get("/api/replay", (req, res) => {
    const cursor = parseCursorQuery(req, res);
    if (!cursor) return;
    res.json(buildView(store.allEntries(), cursor));
  });

  app.get("/api/span/:traceId/:spanId", (req, res) => {
    const cursor = parseCursorQuery(req, res);
    if (!cursor) return;
    const versions = store.spanVersions(req.params.traceId, req.params.spanId);
    if (versions.length === 0) {
      res.status(404).json({ error: "span 不存在" });
      return;
    }
    res.json(explainSpanVersions(versions, req.params.traceId, req.params.spanId, cursor));
  });

  app.post("/api/admin/rebuild", (_req, res) => {
    const before = store.projectionChecksum();
    const rebuilt = store.rebuildProjection();
    res.json({
      contract: "rebuild-report/1",
      before,
      after: rebuilt.checksum,
      match: before === rebuilt.checksum,
      rows: rebuilt.rows,
    });
  });

  /* ---------- IncidentSnapshot：封存 / 查询 / 备注 / 复核 ---------- */

  // 封存幂等：相同账本与游标 → 相同 digest → 返回已存在快照，不重复写入。
  app.post("/api/snapshots", express.json({ limit: "1mb" }), (req, res) => {
    const parsed = parseSealRequest(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { cursorA, cursorB, label } = parsed.value;
    const computed = computeSnapshot(store, cursorA, cursorB, label);
    const { existing } = store.saveSnapshot(computed);
    const stored = store.getSnapshot(computed.id) ?? computed;
    const result: SealResponseV1 = { contract: "seal-response/1", snapshot: stored, existing };
    res.status(existing ? 200 : 201).json(result);
  });

  app.get("/api/snapshots", (_req, res) => {
    res.json({ contract: "snapshot-list/1", items: store.listSnapshots() });
  });

  app.get("/api/snapshots/:id", (req, res) => {
    const snapshot = store.getSnapshot(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "快照不存在" });
      return;
    }
    res.json({
      contract: "snapshot-detail/1",
      snapshot,
      verify: verifySnapshot(store, snapshot),
    });
  });

  app.get("/api/snapshots/:id/verify", (req, res) => {
    const snapshot = store.getSnapshot(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "快照不存在" });
      return;
    }
    res.json(verifySnapshot(store, snapshot));
  });

  // 备注只追加，不修改封存内容，也不影响 digest。
  app.post("/api/snapshots/:id/notes", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseNoteInput(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const note = store.addNote(req.params.id, parsed.value.author, parsed.value.text);
    if (!note) {
      res.status(404).json({ error: "快照不存在" });
      return;
    }
    res.status(201).json(note);
  });

  /* ---------- InvestigationSession：跨班协作 ---------- */

  const sessions = new SessionService(store, emitter);
  const respondSession = <T>(res: Response, r: SessionResult<T>, okStatus = 200): void => {
    if (!r.ok) {
      const body: GateErrorV1 = {
        contract: "gate-error/1",
        error: r.error as GateErrorV1["error"],
        lease: r.lease,
      };
      res.status(r.status).json(body);
      return;
    }
    res.status(okStatus).json(r.value);
  };

  app.post("/api/sessions", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseCreateSession(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(res, sessions.createSession(parsed.value), 201);
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({ contract: "session-list/1", items: sessions.listSessions() });
  });

  app.get("/api/sessions/:id", (req, res) => {
    const state = sessions.getSession(req.params.id);
    if (!state) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    res.json(state);
  });

  app.post("/api/sessions/:id/join", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseJoinSession(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(res, sessions.join(req.params.id, parsed.value.clientId, parsed.value.name));
  });

  app.post("/api/sessions/:id/lease", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseLeaseAcquire(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(
      res,
      sessions.acquireLease(req.params.id, parsed.value.clientId, parsed.value.name, parsed.value.ttlMs),
    );
  });

  app.post("/api/sessions/:id/lease/renew", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseLeaseToken(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(
      res,
      sessions.renewLease(req.params.id, parsed.value.clientId, parsed.value.fencingToken, parsed.value.ttlMs),
    );
  });

  app.post("/api/sessions/:id/lease/release", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseLeaseToken(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(res, sessions.releaseLease(req.params.id, parsed.value.clientId, parsed.value.fencingToken));
  });

  app.post("/api/sessions/:id/cursor", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseCursorPush(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(
      res,
      sessions.pushCursor(req.params.id, parsed.value.clientId, parsed.value.fencingToken, parsed.value.cursor),
    );
  });

  app.post("/api/sessions/:id/seal", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseSessionSeal(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const r = sessions.sealSnapshot(
      req.params.id,
      parsed.value.clientId,
      parsed.value.fencingToken,
      parsed.value.cursorA,
      parsed.value.cursorB,
      parsed.value.label,
    );
    if (!r.ok) {
      respondSession(res, r);
      return;
    }
    res.status(r.value.existing ? 200 : 201).json({
      contract: "seal-response/1",
      snapshot: r.value.snapshot,
      existing: r.value.existing,
    });
  });

  // 备注全员可写（无需租约），服务端按确定性规则归并
  app.post("/api/sessions/:id/notes", express.json({ limit: "64kb" }), (req, res) => {
    const parsed = parseSessionNote(req.body as unknown);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    respondSession(res, sessions.addNote(req.params.id, parsed.value), 201);
  });

  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.status(503).send("web 前端尚未构建：请先运行 npm run build");
    });
  }

  return app;
}
