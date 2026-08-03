import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ReplayEngine } from './replay.js';
import { FencingError } from './replay.js';
import { parseNdjsonBody } from './ingest.js';
import type { WsServerMessage, WsClientMessage } from '../shared/contracts.js';
import {
  parseReplayCursor,
  parseCreateSnapshotRequest,
  parseSnapshotSlot,
} from '../shared/contracts.js';
import type { SampleRunner } from './sampleRunner.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseCursorFromQuery(url: URL): { cursor: ReturnType<typeof parseReplayCursor> | null; error: string | null } {
  const et = url.searchParams.get('eventTime');
  const is = url.searchParams.get('ingestSequence');
  if (et === null && is === null) {
    return { cursor: null, error: null };
  }
  try {
    const cursor = parseReplayCursor({
      eventTime: Number(et ?? '0'),
      ingestSequence: Number(is ?? '0'),
    });
    return { cursor, error: null };
  } catch (e) {
    return { cursor: null, error: (e as Error).message };
  }
}

export interface AppContext {
  engine: ReplayEngine;
  sampleRunner: SampleRunner;
  publicDir: string;
}

export function createAppServer(ctx: AppContext) {
  const { engine, sampleRunner, publicDir } = ctx;
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = reqUrl.pathname;

    try {
      if (pathname === '/api/head' && method === 'GET') {
        const head = engine.getHead();
        sendJson(res, 200, { head, totalLedgerRecords: engine.totalRecords() });
        return;
      }

      if (pathname === '/api/replay' && method === 'GET') {
        const { cursor, error } = parseCursorFromQuery(reqUrl);
        if (error) {
          sendJson(res, 400, { error });
          return;
        }
        const view = engine.getView(cursor ?? engine.getHead());
        sendJson(res, 200, view);
        return;
      }

      if (pathname.startsWith('/api/span/') && method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length !== 4) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        const traceId = decodeURIComponent(parts[2]!);
        const spanId = decodeURIComponent(parts[3]!);
        const { cursor, error } = parseCursorFromQuery(reqUrl);
        if (error) {
          sendJson(res, 400, { error });
          return;
        }
        const versions = engine.explainSpan(traceId, spanId, cursor ?? engine.getHead());
        sendJson(res, 200, { traceId, spanId, versions });
        return;
      }

      if (pathname === '/api/ingest' && method === 'POST') {
        const text = await readBody(req);
        const { events, errors } = parseNdjsonBody(text);
        if (events.length === 0) {
          sendJson(res, 400, { accepted: 0, rejected: errors.length, firstSequence: null, lastSequence: null, errors });
          return;
        }
        const records = engine.ingestMany(events);
        sendJson(res, 200, {
          accepted: records.length,
          rejected: errors.length,
          firstSequence: records[0]!.ingestSequence,
          lastSequence: records[records.length - 1]!.ingestSequence,
          errors,
        });
        return;
      }

      if (pathname === '/api/sample/start' && method === 'POST') {
        const count = sampleRunner.start();
        sendJson(res, 200, { running: true, scheduled: count });
        broadcast({ type: 'sample', running: true });
        return;
      }

      if (pathname === '/api/sample/stop' && method === 'POST') {
        sampleRunner.stop();
        sendJson(res, 200, { running: false });
        broadcast({ type: 'sample', running: false });
        return;
      }

      if (pathname === '/api/snapshots' && method === 'POST') {
        const text = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch (e) {
          sendJson(res, 400, { error: `invalid JSON: ${(e as Error).message}` });
          return;
        }
        let req2;
        try {
          req2 = parseCreateSnapshotRequest(body);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        const fencingToken = typeof (body as Record<string, unknown>).fencingToken === 'number'
          ? ((body as Record<string, unknown>).fencingToken as number)
          : null;
        const clientId = typeof (body as Record<string, unknown>).clientId === 'string'
          ? ((body as Record<string, unknown>).clientId as string)
          : null;
        let snapshot;
        try {
          snapshot = engine.createSnapshot(
            req2.slot,
            req2.label ?? (req2.slot === 'A' ? 'Moment A' : 'Moment B'),
            req2.cursor,
            req2.notes ?? '',
            { clientId, token: fencingToken },
          );
        } catch (e) {
          if (e instanceof FencingError) {
            sendJson(res, 409, { error: e.leaseError });
            return;
          }
          throw e;
        }
        sendJson(res, 201, snapshot);
        return;
      }

      if (pathname === '/api/snapshots' && method === 'GET') {
        sendJson(res, 200, { snapshots: engine.listSnapshots() });
        return;
      }

      if (pathname === '/api/snapshots/compare' && method === 'GET') {
        const aId = reqUrl.searchParams.get('a');
        const bId = reqUrl.searchParams.get('b');
        if (aId && bId) {
          const diff = engine.compareSnapshots(aId, bId);
          sendJson(res, 200, diff);
        } else {
          const diff = engine.compareLatestAB();
          if (!diff) {
            sendJson(res, 404, { error: 'need both A and B snapshots' });
            return;
          }
          sendJson(res, 200, diff);
        }
        return;
      }

      const snapshotMatch = pathname.match(/^\/api\/snapshots\/([^/]+)$/);
      if (snapshotMatch && method === 'GET') {
        const snap = engine.getSnapshot(decodeURIComponent(snapshotMatch[1]!));
        if (!snap) {
          sendJson(res, 404, { error: 'snapshot not found' });
          return;
        }
        sendJson(res, 200, snap);
        return;
      }

      const notesMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/notes$/);
      if (notesMatch && method === 'PUT') {
        const text = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch (e) {
          sendJson(res, 400, { error: `invalid JSON: ${(e as Error).message}` });
          return;
        }
        const notes = typeof body === 'object' && body !== null && 'notes' in body
          ? (body as { notes: unknown }).notes
          : undefined;
        if (typeof notes !== 'string') {
          sendJson(res, 400, { error: 'notes must be a string' });
          return;
        }
        const updated = engine.updateSnapshotNotes(decodeURIComponent(notesMatch[1]!), notes);
        if (!updated) {
          sendJson(res, 404, { error: 'snapshot not found' });
          return;
        }
        sendJson(res, 200, updated);
        return;
      }

      const slotMatch = pathname.match(/^\/api\/snapshots\/slot\/([AB])$/);
      if (slotMatch && method === 'GET') {
        const slot = parseSnapshotSlot(slotMatch[1]);
        const snap = engine.getLatestSnapshot(slot);
        if (!snap) {
          sendJson(res, 404, { error: 'no snapshot for slot' });
          return;
        }
        sendJson(res, 200, snap);
        return;
      }

      if (pathname === '/api/session' && method === 'GET') {
        const session = engine.getSession();
        sendJson(res, 200, {
          lease: session.getLease(),
          sharedCursor: session.getSharedCursor(),
          notes: session.getNotes(),
        });
        return;
      }

      if (pathname === '/api/session/lease' && method === 'POST') {
        const text = await readBody(req);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* empty */ }
        const clientId = typeof body.clientId === 'string' ? body.clientId : '';
        const clientName = typeof body.clientName === 'string' ? body.clientName : 'anonymous';
        const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : 30000;
        if (!clientId) {
          sendJson(res, 400, { error: 'clientId required' });
          return;
        }
        const result = engine.getSession().acquire(clientId, clientName, ttlMs);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (pathname === '/api/session/lease/renew' && method === 'POST') {
        const text = await readBody(req);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* empty */ }
        const clientId = typeof body.clientId === 'string' ? body.clientId : '';
        const fencingToken = typeof body.fencingToken === 'number' ? body.fencingToken : -1;
        const result = engine.getSession().renew(clientId, fencingToken);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (pathname === '/api/session/lease/release' && method === 'POST') {
        const text = await readBody(req);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* empty */ }
        const clientId = typeof body.clientId === 'string' ? body.clientId : '';
        const fencingToken = typeof body.fencingToken === 'number' ? body.fencingToken : -1;
        const ok = engine.getSession().release(clientId, fencingToken);
        sendJson(res, ok ? 200 : 409, { ok });
        return;
      }

      if (pathname === '/api/session/cursor' && method === 'POST') {
        const text = await readBody(req);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        const clientId = typeof body.clientId === 'string' ? body.clientId : '';
        const fencingToken = typeof body.fencingToken === 'number' ? body.fencingToken : null;
        let cursor;
        try {
          cursor = parseReplayCursor(body.cursor);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        const result = engine.getSession().advanceCursor(clientId, fencingToken ?? -1, cursor);
        if (!result.ok) {
          sendJson(res, 409, { error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, cursor });
        return;
      }

      if (pathname === '/api/session/notes' && method === 'GET') {
        sendJson(res, 200, { notes: engine.getSession().getNotes() });
        return;
      }

      if (pathname === '/api/session/notes' && method === 'POST') {
        const text = await readBody(req);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        const note = body.note as Record<string, unknown> | undefined;
        if (!note || typeof note.clientId !== 'string' || typeof note.clientSeq !== 'number' || typeof note.text !== 'string') {
          sendJson(res, 400, { error: 'note requires clientId, clientSeq, text' });
          return;
        }
        const result = engine.getSession().addNote({
          clientId: note.clientId,
          clientSeq: note.clientSeq,
          authorName: typeof note.authorName === 'string' ? note.authorName : note.clientId,
          text: note.text,
          snapshotId: typeof note.snapshotId === 'string' ? note.snapshotId : null,
          createdAt: typeof note.createdAt === 'number' ? note.createdAt : undefined,
        });
        sendJson(res, 200, { ok: true, note: result.note, isNew: result.isNew });
        return;
      }

      if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, records: engine.totalRecords() });
        return;
      }

      if (method === 'GET') {
        await serveStatic(pathname, publicDir, res);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const sockets = new Set<WebSocket>();

  function broadcast(msg: WsServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  wss.on('connection', (ws) => {
    sockets.add(ws);
    const session = engine.getSession();
    const head = engine.getHead();
    ws.send(JSON.stringify({ type: 'snapshot', head, totalLedgerRecords: engine.totalRecords() } satisfies WsServerMessage));
    ws.send(JSON.stringify({
      type: 'session-state',
      lease: session.getLease(),
      notes: session.getNotes(),
      now: Date.now(),
      selfClientId: null,
    } satisfies WsServerMessage));

    const unsubscribe = engine.subscribe((record, h) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'record', record, head: h } satisfies WsServerMessage));
      }
    });

    const unsubscribeSession = session.subscribe((event) => {
      let msg: WsServerMessage | null = null;
      if (event.kind === 'lease') {
        msg = { type: 'lease-changed', lease: event.lease, reason: event.reason } satisfies WsServerMessage;
      } else if (event.kind === 'cursor') {
        msg = {
          type: 'cursor-broadcast',
          cursor: event.cursor,
          fencingToken: event.fencingToken,
          byClientId: event.byClientId,
        } satisfies WsServerMessage;
      } else if (event.kind === 'notes') {
        msg = { type: 'notes-appended', notes: event.notes } satisfies WsServerMessage;
      }
      if (msg && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on('message', (data) => {
      let parsed: WsClientMessage;
      try {
        parsed = JSON.parse(data.toString()) as WsClientMessage;
      } catch {
        return;
      }
      try {
        switch (parsed.type) {
          case 'acquire-lease': {
            const result = session.acquire(
              parsed.clientId,
              parsed.clientName,
              parsed.ttlMs,
            );
            ws.send(JSON.stringify({
              type: result.ok ? 'lease-acquired' : 'lease-error',
              ...(result.ok
                ? { lease: result.lease }
                : { error: result.error }),
            } as WsServerMessage));
            break;
          }
          case 'renew-lease': {
            const result = session.renew(parsed.clientId, parsed.fencingToken);
            if (!result.ok && result.error) {
              ws.send(JSON.stringify({ type: 'lease-error', error: result.error } satisfies WsServerMessage));
            }
            break;
          }
          case 'release-lease': {
            session.release(parsed.clientId, parsed.fencingToken);
            break;
          }
          case 'advance-cursor': {
            const result = session.advanceCursor(parsed.clientId, parsed.fencingToken, parsed.cursor);
            if (!result.ok && result.error) {
              ws.send(JSON.stringify({ type: 'lease-error', error: result.error } satisfies WsServerMessage));
            }
            break;
          }
          case 'add-note': {
            session.addNote({
              clientId: parsed.note.clientId,
              clientSeq: parsed.note.clientSeq,
              authorName: parsed.note.authorName,
              text: parsed.note.text,
              snapshotId: parsed.note.snapshotId,
              createdAt: parsed.note.createdAt,
            });
            break;
          }
          default:
            break;
        }
      } catch {
        // ignore malformed ws messages
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      unsubscribe();
      unsubscribeSession();
    });
    ws.on('error', () => {
      sockets.delete(ws);
      unsubscribe();
      unsubscribeSession();
    });
  });

  return { server, broadcast, wss };
}

async function serveStatic(pathname: string, publicDir: string, res: ServerResponse): Promise<void> {
  let relPath = pathname === '/' ? '/index.html' : pathname;
  relPath = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, relPath);
  if (!existsSync(filePath)) {
    const indexPath = join(publicDir, 'index.html');
    if (existsSync(indexPath)) {
      const content = await readFile(indexPath);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(content);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const content = await readFile(filePath);
  const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime });
  res.end(content);
}

export function defaultPublicDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', 'public');
}
