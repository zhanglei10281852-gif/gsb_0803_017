import { createServer, IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync } from "fs";
import { extname, join, resolve } from "path";
import { AddressInfo } from "net";
import { WebSocketServer, WebSocket } from "ws";
import {
  CONTRACT_VERSION,
  HealthResponse,
  IngestResponse,
  LiveLedgerEvent,
  ReplayCursor,
} from "../shared/contracts";
import { parseNdjson } from "../shared/validation";
import { ReplayService } from "./replayService";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface ServerOptions {
  readonly service: ReplayService;
  readonly port: number;
  readonly host?: string;
  readonly staticDir?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseCursor(url: URL): ReplayCursor {
  const seq = Number(url.searchParams.get("ingestSequence") ?? "-1");
  const eventTime = Number(url.searchParams.get("eventTime") ?? "-1");
  return {
    ingestSequence: Number.isFinite(seq) ? seq : -1,
    eventTime: Number.isFinite(eventTime) ? eventTime : -1,
  };
}

function isCursor(value: unknown): value is ReplayCursor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { eventTime?: unknown; ingestSequence?: unknown };
  return (
    typeof candidate.eventTime === "number" &&
    Number.isFinite(candidate.eventTime) &&
    typeof candidate.ingestSequence === "number" &&
    Number.isInteger(candidate.ingestSequence)
  );
}

function validateCreateSnapshotRequest(body: unknown): string | null {
  if (typeof body !== "object" || body === null)
    return "body must be an object";
  const candidate = body as {
    cursorA?: unknown;
    cursorB?: unknown;
    labelA?: unknown;
    labelB?: unknown;
    notes?: unknown;
  };
  if (!isCursor(candidate.cursorA))
    return "cursorA must be {eventTime, ingestSequence}";
  if (!isCursor(candidate.cursorB))
    return "cursorB must be {eventTime, ingestSequence}";
  if (candidate.labelA !== undefined && typeof candidate.labelA !== "string")
    return "labelA must be string";
  if (candidate.labelB !== undefined && typeof candidate.labelB !== "string")
    return "labelB must be string";
  if (candidate.notes !== undefined && typeof candidate.notes !== "string")
    return "notes must be string";
  return null;
}

export function createAppServer(options: ServerOptions) {
  const { service, port, host = "127.0.0.1" } = options;
  const staticDir = options.staticDir ?? resolve(__dirname, "../client");

  const wss = new WebSocketServer({ noServer: true });
  const broadcast = (event: LiveLedgerEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (req.method === "GET" && url.pathname === "/api/health") {
        const health: HealthResponse = {
          contractVersion: CONTRACT_VERSION,
          ok: true,
          ledgerTotalRecords: service.totalRecords,
          maxIngestSequence: service.maxIngestSequence,
          serverTime: Date.now(),
        };
        sendJson(res, 200, health);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ingest") {
        const text = await readBody(req);
        const { events, errors } = parseNdjson(text);
        const result: IngestResponse = service.ingest(events);
        const response: IngestResponse = {
          ...result,
          rejected: errors.length,
          errors,
        };
        if (result.accepted > 0) {
          const cursor = service.liveCursor();
          broadcast({
            type: "ledger-appended",
            maxIngestSequence: cursor.ingestSequence,
            maxEventTime: cursor.eventTime,
            totalRecords: service.totalRecords,
            serverTime: Date.now(),
          });
        }
        sendJson(
          res,
          errors.length > 0 && result.accepted === 0 ? 400 : 200,
          response,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/view") {
        const requested = parseCursor(url);
        const liveParam = url.searchParams.get("live");
        const live = liveParam !== "0" && liveParam !== "false";
        let cursor: ReplayCursor;
        if (live || requested.ingestSequence < 0) {
          cursor = service.liveCursor();
        } else {
          const watermark = service
            .getEngine()
            .watermarkAt(requested.ingestSequence);
          cursor = {
            ingestSequence: requested.ingestSequence,
            eventTime:
              requested.eventTime > 0 && requested.eventTime < watermark
                ? requested.eventTime
                : watermark,
          };
        }
        const view = service.buildView(
          cursor,
          live || requested.ingestSequence < 0,
        );
        sendJson(res, 200, view);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/span") {
        const traceId = url.searchParams.get("traceId");
        const spanId = url.searchParams.get("spanId");
        if (!traceId || !spanId) {
          sendJson(res, 400, { error: "traceId and spanId are required" });
          return;
        }
        const requested = parseCursor(url);
        const cursor =
          requested.ingestSequence < 0
            ? service.liveCursor()
            : {
                ingestSequence: requested.ingestSequence,
                eventTime:
                  requested.eventTime > 0
                    ? requested.eventTime
                    : service.getEngine().watermarkAt(requested.ingestSequence),
              };
        const detail = service.buildSpanDetail(traceId, spanId, cursor);
        if (!detail) {
          sendJson(res, 404, { error: "span not found at cursor" });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const info = service.getEngine();
        sendJson(res, 200, {
          contractVersion: CONTRACT_VERSION,
          liveCursor: service.liveCursor(),
          bounds: info.ledgerBounds,
          totalRecords: service.totalRecords,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/snapshots") {
        sendJson(res, 200, {
          contractVersion: CONTRACT_VERSION,
          snapshots: service.listSnapshots(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshots") {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const requestError = validateCreateSnapshotRequest(parsed);
        if (requestError) {
          sendJson(res, 400, { error: requestError });
          return;
        }
        const request = parsed as {
          labelA?: string;
          labelB?: string;
          cursorA: { eventTime: number; ingestSequence: number };
          cursorB: { eventTime: number; ingestSequence: number };
          notes?: string;
        };
        const snapshot = service.createSnapshot({
          labelA: request.labelA,
          labelB: request.labelB,
          cursorA: request.cursorA,
          cursorB: request.cursorB,
          notes: request.notes,
        });
        sendJson(res, 201, snapshot);
        return;
      }

      const snapshotMatch = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
      if (req.method === "GET" && snapshotMatch) {
        const snapshot = service.getSnapshot(
          decodeURIComponent(snapshotMatch[1]!),
        );
        if (!snapshot) {
          sendJson(res, 404, { error: "snapshot not found" });
          return;
        }
        sendJson(res, 200, snapshot);
        return;
      }
      if (req.method === "PATCH" && snapshotMatch) {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof (parsed as { notes?: unknown }).notes !== "string"
        ) {
          sendJson(res, 400, { error: "notes string is required" });
          return;
        }
        const notes = (parsed as { notes: string }).notes;
        const updated = service.updateSnapshotNotes(
          decodeURIComponent(snapshotMatch[1]!),
          notes,
        );
        if (!updated) {
          sendJson(res, 404, { error: "snapshot not found" });
          return;
        }
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === "GET") {
        let requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        if (requestPath.includes("..")) {
          sendJson(res, 400, { error: "invalid path" });
          return;
        }
        const filePath = join(staticDir, requestPath);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          const mime =
            MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": "no-store",
          });
          res.end(content);
          return;
        }
        const indexPath = join(staticDir, "index.html");
        if (existsSync(indexPath)) {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(readFileSync(indexPath));
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (url.pathname !== "/replay") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const listen = (): Promise<AddressInfo> =>
    new Promise((resolveListen) => {
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo;
        resolveListen(address);
      });
    });

  const close = (): Promise<void> =>
    new Promise((resolveClose) => {
      wss.close();
      server.close(() => resolveClose());
    });

  return { server, listen, close, broadcast };
}
