import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocket } from 'ws';
import { Ledger } from './ledger';
import { parseNdjson } from '../shared/ndjson';
import { projectView } from '../shared/projection';
import {
  CONTRACT_VERSION,
  ReplayCursor,
  type IngestResult,
  type LiveHello,
  type LiveUpdate,
  type ProjectionView,
} from '../shared/contract';

export interface BuildAppOptions {
  dbPath: string;
  /** Absolute path to the built web assets; static serving is skipped if absent. */
  webDir?: string;
}

export interface AppBundle {
  app: FastifyInstance;
  ledger: Ledger;
}

/**
 * Build the Fastify app around a ledger. Exposed separately from `main` so
 * tests can boot it against a temporary database and reopen it to prove
 * restart recovery.
 */
export function buildApp(options: BuildAppOptions): AppBundle {
  const ledger = new Ledger(options.dbPath);
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  const sockets = new Set<WebSocket>();

  // Accept raw NDJSON bodies for ingest.
  app.addContentTypeParser(
    ['application/x-ndjson', 'text/plain', 'application/octet-stream'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  void app.register(fastifyWebsocket);

  app.get('/api/health', async () => ({
    ok: true,
    contractVersion: CONTRACT_VERSION,
    count: ledger.count(),
  }));

  // --- Ingest: real network entry point for continuously arriving spans. ---
  app.post('/api/ingest', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const { events, errors } = parseNdjson(raw);
    const { accepted, duplicates } = ledger.appendBatch(events, Date.now());

    if (accepted.length > 0) broadcast(accepted[accepted.length - 1]!);

    const result: IngestResult = {
      accepted: accepted.length,
      duplicates,
      maxIngestSequence: ledger.bounds().maxIngestSequence,
    };
    if (errors.length > 0) {
      return reply.status(207).send({ ...result, errors });
    }
    return reply.send(result);
  });

  // --- Bounds: lets the UI build the timeline without pulling the ledger. ---
  app.get('/api/bounds', async () => ({
    contractVersion: CONTRACT_VERSION,
    bounds: ledger.bounds(),
  }));

  // --- View: the reproducible projection at an arbitrary ReplayCursor. ---
  app.get('/api/view', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bounds = ledger.bounds();
    const eventTimeMs = numberOr(q.eventTimeMs, bounds.maxEventTimeMs);
    const ingestSequence = numberOr(q.ingestSequence, bounds.maxIngestSequence);
    const parsed = ReplayCursor.safeParse({ eventTimeMs, ingestSequence });
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid cursor', issues: parsed.error.issues });
    }
    const view = viewAt(ledger, parsed.data);
    return reply.send(view);
  });

  // --- Live follow: push the ledger head as new records arrive. ---
  app.get('/api/live', { websocket: true }, (socket) => {
    sockets.add(socket);
    const hello: LiveHello = {
      type: 'hello',
      contractVersion: CONTRACT_VERSION,
      bounds: ledger.bounds(),
    };
    socket.send(JSON.stringify(hello));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  // --- Static: serve the built React app so `npm start` opens a real page. ---
  if (options.webDir && existsSync(options.webDir)) {
    void app.register(fastifyStatic, { root: resolve(options.webDir), prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  function broadcast(latest: LiveUpdate['latest']): void {
    const msg: LiveUpdate = {
      type: 'live',
      contractVersion: CONTRACT_VERSION,
      bounds: ledger.bounds(),
      latest,
    };
    const payload = JSON.stringify(msg);
    for (const s of sockets) {
      try {
        s.send(payload);
      } catch {
        sockets.delete(s);
      }
    }
  }

  app.addHook('onClose', async () => {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    ledger.close();
  });

  return { app, ledger };
}

/**
 * Reproduce a view at a cursor. The pure projection performs all cursor
 * filtering itself, so it needs the *whole* immutable ledger: only then can it
 * know that a newer revision exists beyond the cursor (`supersededLater`).
 */
export function viewAt(ledger: Ledger, cursor: ReplayCursor): ProjectionView {
  const records = ledger.readAll();
  return projectView(records, cursor);
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
