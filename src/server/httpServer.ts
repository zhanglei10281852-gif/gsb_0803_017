import { createServer, IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync } from "fs";
import { extname, join, resolve } from "path";
import { AddressInfo } from "net";
import { WebSocketServer, WebSocket } from "ws";
import {
  AddNoteRequest,
  AdvanceCursorRequest,
  AcquireLeaseRequest,
  CONTRACT_VERSION,
  CreateSessionRequest,
  HealthResponse,
  IngestResponse,
  InvestigationSession,
  LiveLedgerEvent,
  ReplayCursor,
  SealSnapshotInSessionRequest,
  SessionEvent,
} from "../shared/contracts";
import { parseNdjson } from "../shared/validation";
import { ReplayService } from "./replayService";
import { InvestigationService } from "./investigationService";

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseJsonObject(body: string): unknown | { error: string } {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return { error: "invalid JSON body" };
  }
}

function validateCreateSession(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be object";
  const c = body as CreateSessionRequest;
  if (!isNonEmptyString(c.anchorSnapshotId)) return "anchorSnapshotId required";
  if (!isNonEmptyString(c.participantId)) return "participantId required";
  if (!isNonEmptyString(c.participantName)) return "participantName required";
  return null;
}

function validateAcquire(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be object";
  const c = body as AcquireLeaseRequest;
  if (!isNonEmptyString(c.participantId)) return "participantId required";
  if (!isNonEmptyString(c.participantName)) return "participantName required";
  if (typeof c.fencingToken !== "number" || !Number.isInteger(c.fencingToken))
    return "fencingToken must be integer";
  return null;
}

function validateAdvance(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be object";
  const c = body as AdvanceCursorRequest;
  if (!isNonEmptyString(c.participantId)) return "participantId required";
  if (typeof c.fencingToken !== "number" || !Number.isInteger(c.fencingToken))
    return "fencingToken must be integer";
  if (!isCursor(c.cursor)) return "cursor invalid";
  if (typeof c.label !== "string") return "label required";
  return null;
}

function validateSeal(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be object";
  const c = body as SealSnapshotInSessionRequest;
  if (!isNonEmptyString(c.participantId)) return "participantId required";
  if (typeof c.fencingToken !== "number" || !Number.isInteger(c.fencingToken))
    return "fencingToken must be integer";
  if (!isCursor(c.cursor)) return "cursor invalid";
  if (typeof c.label !== "string") return "label required";
  if (c.notes !== undefined && typeof c.notes !== "string")
    return "notes must be string";
  return null;
}

function validateNote(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be object";
  const c = body as AddNoteRequest;
  if (!isNonEmptyString(c.sessionId)) return "sessionId required";
  if (!isNonEmptyString(c.participantId)) return "participantId required";
  if (!isNonEmptyString(c.participantName)) return "participantName required";
  if (!isNonEmptyString(c.text)) return "text required";
  if (!isNonEmptyString(c.clientNoteId)) return "clientNoteId required";
  return null;
}

export function createAppServer(options: ServerOptions) {
  const { service, port, host = "127.0.0.1" } = options;
  const staticDir = options.staticDir ?? resolve(__dirname, "../client");
  const investigation = new InvestigationService(service.getLedger(), service);

  const wss = new WebSocketServer({ noServer: true });
  const sessionRooms = new Map<string, Set<WebSocket>>();

  const broadcast = (event: LiveLedgerEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  const broadcastSession = (sessionId: string, event: SessionEvent) => {
    const room = sessionRooms.get(sessionId);
    if (!room) return;
    const payload = JSON.stringify(event);
    for (const client of room) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  const emitSessionState = (sessionId: string) => {
    const session = investigation.getSession(sessionId);
    if (!session) return;
    broadcastSession(sessionId, {
      type: "session-state",
      session,
      yourRole: session.lease ? "follower" : "observer",
      yourState: "following",
    });
  };

  const joinSessionRoom = (sessionId: string, ws: WebSocket) => {
    let room = sessionRooms.get(sessionId);
    if (!room) {
      room = new Set();
      sessionRooms.set(sessionId, room);
    }
    room.add(ws);
    (ws as WebSocket & { __sessionId?: string }).__sessionId = sessionId;
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

      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const parsed = parseJsonObject(await readBody(req));
        if ("error" in (parsed as object)) {
          sendJson(res, 400, { error: (parsed as { error: string }).error });
          return;
        }
        const err = validateCreateSession(parsed);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        const body = parsed as CreateSessionRequest;
        const session = investigation.createSession({
          anchorSnapshotId: body.anchorSnapshotId,
          participantId: body.participantId,
          participantName: body.participantName,
        });
        broadcastSession(session.id, {
          type: "session-state",
          session,
          yourRole: "leader",
          yourState: "following",
        });
        sendJson(res, 201, session);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(
          url.pathname.slice("/api/sessions/".length),
        );
        const session = investigation.getSession(id);
        if (!session) {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        sendJson(res, 200, session);
        return;
      }

      if (
        req.method === "POST" &&
        /^\/api\/sessions\/[^/]+\/lease$/.test(url.pathname)
      ) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const parsed = parseJsonObject(await readBody(req));
        if ("error" in (parsed as object)) {
          sendJson(res, 400, { error: (parsed as { error: string }).error });
          return;
        }
        const err = validateAcquire(parsed);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        const body = parsed as AcquireLeaseRequest;
        const result = investigation.acquireLease(
          id,
          body.participantId,
          body.participantName,
          body.fencingToken,
        );
        if (result.ok && result.lease) {
          emitSessionState(id);
        }
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (
        req.method === "POST" &&
        /^\/api\/sessions\/[^/]+\/cursor$/.test(url.pathname)
      ) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const parsed = parseJsonObject(await readBody(req));
        if ("error" in (parsed as object)) {
          sendJson(res, 400, { error: (parsed as { error: string }).error });
          return;
        }
        const err = validateAdvance(parsed);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        const body = parsed as AdvanceCursorRequest;
        try {
          const session = investigation.advanceSharedCursor(
            id,
            body.participantId,
            body.fencingToken,
            body.cursor,
            body.label,
            body.snapshotId ?? null,
          );
          if (session.sharedCursor) {
            broadcastSession(id, {
              type: "cursor-advanced",
              sharedCursor: session.sharedCursor,
            });
          }
          sendJson(res, 200, session);
        } catch (e) {
          sendJson(res, 409, { error: (e as Error).message });
        }
        return;
      }

      if (
        req.method === "POST" &&
        /^\/api\/sessions\/[^/]+\/seal$/.test(url.pathname)
      ) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const parsed = parseJsonObject(await readBody(req));
        if ("error" in (parsed as object)) {
          sendJson(res, 400, { error: (parsed as { error: string }).error });
          return;
        }
        const err = validateSeal(parsed);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        const body = parsed as SealSnapshotInSessionRequest;
        try {
          const result = investigation.sealSnapshot(
            id,
            body.participantId,
            body.fencingToken,
            body.cursor,
            body.label,
            body.notes ?? "",
          );
          broadcastSession(id, {
            type: "snapshot-sealed",
            snapshotId: result.snapshot.id,
            snapshot: result.snapshot,
          });
          broadcastSession(id, {
            type: "cursor-advanced",
            sharedCursor: result.session.sharedCursor!,
          });
          sendJson(res, 201, result.session);
        } catch (e) {
          sendJson(res, 409, { error: (e as Error).message });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/notes") {
        const parsed = parseJsonObject(await readBody(req));
        if ("error" in (parsed as object)) {
          sendJson(res, 400, { error: (parsed as { error: string }).error });
          return;
        }
        const err = validateNote(parsed);
        if (err) {
          sendJson(res, 400, { error: err });
          return;
        }
        const body = parsed as AddNoteRequest;
        const result = investigation.addNote(body);
        if (!result.deduped) {
          broadcastSession(body.sessionId, {
            type: "note-added",
            note: result.note,
          });
        }
        sendJson(res, 200, {
          session: result.session,
          note: result.note,
          deduped: result.deduped,
        });
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
    if (url.pathname !== "/replay" && !url.pathname.startsWith("/replay/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      const parts = url.pathname.split("/");
      const sessionId = parts[2];
      if (sessionId) {
        joinSessionRoom(decodeURIComponent(sessionId), ws);
        const session = investigation.getSession(decodeURIComponent(sessionId));
        if (session) {
          ws.send(
            JSON.stringify({
              type: "session-state",
              session,
              yourRole: "follower",
              yourState: "following",
            } satisfies SessionEvent),
          );
        }
      }
      ws.on("close", () => {
        const tagged = ws as WebSocket & { __sessionId?: string };
        if (tagged.__sessionId) {
          const room = sessionRooms.get(tagged.__sessionId);
          room?.delete(ws);
        }
      });
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
