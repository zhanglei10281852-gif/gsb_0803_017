import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
  buildView,
  explainSpanVersions,
  parseSpanEventLine,
  CONTRACT_VERSION,
  type IngestBatchResultV1,
  type ReplayCursorV1,
  type SpanEventV1,
} from "@replay/shared";
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
