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
  compareSnapshots,
  listSnapshots,
  loadSnapshotView,
  sealSnapshot,
  verifySnapshotDigest,
} from './snapshots';
import {
  SessionError,
  acquireLease,
  addNote,
  advanceSharedCursor,
  checkWriter,
  createSession,
  getSessionState,
  releaseLease,
  renewLease,
} from './collaboration';
import {
  CONTRACT_VERSION,
  ReplayCursor,
  SealSnapshotRequest,
  CreateSessionRequest,
  AcquireLeaseRequest,
  RenewLeaseRequest,
  ReleaseLeaseRequest,
  AdvanceCursorRequest,
  AddNoteRequest,
  type IngestResult,
  type LiveHello,
  type LiveUpdate,
  type ProjectionView,
  type SessionSignal,
  type SessionState,
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

  // --- Snapshots: seal the current cursor as an immutable incident artifact. ---
  app.post('/api/snapshots', async (req, reply) => {
    const parsed = SealSnapshotRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid snapshot request', issues: parsed.error.issues });
    }
    // When sealing under a shared session, the lease + fencing token gates it:
    // only the current valid holder may seal. A stale/expired writer is fenced
    // out even if the request arrives late.
    const writer = parsed.data.writer;
    if (writer !== undefined) {
      const guard = checkWriter(ledger, writer.sessionId, writer.holder, writer.fencingToken, Date.now());
      if (!guard.ok) {
        return reply.status(409).send({
          error: 'not the current lease holder',
          reason: guard.reason,
          state: guard.state,
        });
      }
    }
    const sealed = sealSnapshot(ledger, parsed.data, Date.now());
    return reply.status(201).send(sealed);
  });

  // List all sealed snapshots (metadata + provenance).
  app.get('/api/snapshots', async () => ({
    contractVersion: CONTRACT_VERSION,
    snapshots: listSnapshots(ledger),
  }));

  // Load one sealed snapshot together with its reproduced frozen view.
  app.get('/api/snapshots/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'invalid snapshot id' });
    }
    const loaded = loadSnapshotView(ledger, id);
    if (loaded === null) return reply.status(404).send({ error: 'snapshot not found' });
    return reply.send(loaded);
  });

  // Verify a snapshot still reproduces its sealed digest (immutability proof).
  app.get('/api/snapshots/:id/verify', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'invalid snapshot id' });
    }
    const loaded = loadSnapshotView(ledger, id);
    if (loaded === null) return reply.status(404).send({ error: 'snapshot not found' });
    return reply.send({
      contractVersion: CONTRACT_VERSION,
      id,
      digest: loaded.snapshot.provenance.digest,
      valid: verifySnapshotDigest(ledger, id),
    });
  });

  // --- Compare: deterministic A -> B diff of two sealed snapshots. ---
  app.get('/api/compare', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const fromId = Number(q.from);
    const toId = Number(q.to);
    if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId <= 0 || toId <= 0) {
      return reply.status(400).send({ error: 'from and to snapshot ids are required' });
    }
    const comparison = compareSnapshots(ledger, fromId, toId);
    if (comparison === null) return reply.status(404).send({ error: 'snapshot not found' });
    return reply.send(comparison);
  });

  // --- Collaboration sessions: lease + fencing + deterministic notes. ---
  function sessionErrorStatus(code: SessionError['code']): number {
    switch (code) {
      case 'not-found':
        return 404;
      case 'anchor-mismatch':
        return 409;
      case 'conflict':
        return 409;
      case 'invalid':
        return 400;
      default:
        return 400;
    }
  }

  // Create a shared session anchored to a sealed snapshot (the handoff anchor).
  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid session request', issues: parsed.error.issues });
    }
    try {
      const state = createSession(ledger, parsed.data, Date.now());
      broadcastSession(state);
      return reply.status(201).send(state);
    } catch (e) {
      if (e instanceof SessionError) return reply.status(sessionErrorStatus(e.code)).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  // Read the full, reconnect-safe session state (source of truth on reconnect).
  app.get('/api/sessions/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'invalid session id' });
    const state = getSessionState(ledger, id, Date.now());
    if (state === null) return reply.status(404).send({ error: 'session not found' });
    return reply.send(state);
  });

  app.post('/api/sessions/:id/lease', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = AcquireLeaseRequest.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'invalid lease request' });
    }
    try {
      const state = acquireLease(ledger, id, parsed.data.holder, parsed.data.ttlMs, Date.now());
      broadcastSession(state);
      return reply.status(201).send(state);
    } catch (e) {
      if (e instanceof SessionError) return reply.status(sessionErrorStatus(e.code)).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  app.put('/api/sessions/:id/lease', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = RenewLeaseRequest.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'invalid renew request' });
    }
    try {
      const state = renewLease(ledger, id, parsed.data.holder, parsed.data.fencingToken, parsed.data.ttlMs, Date.now());
      broadcastSession(state);
      return reply.send(state);
    } catch (e) {
      if (e instanceof SessionError) return reply.status(sessionErrorStatus(e.code)).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  app.delete('/api/sessions/:id/lease', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = ReleaseLeaseRequest.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'invalid release request' });
    }
    try {
      const state = releaseLease(ledger, id, parsed.data.holder, parsed.data.fencingToken, Date.now());
      broadcastSession(state);
      return reply.send(state);
    } catch (e) {
      if (e instanceof SessionError) return reply.status(sessionErrorStatus(e.code)).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  // Advance the shared cursor (owner-only, gated by fencing token).
  app.post('/api/sessions/:id/cursor', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = AdvanceCursorRequest.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'invalid cursor request' });
    }
    const { guard, state } = advanceSharedCursor(
      ledger,
      id,
      parsed.data.holder,
      parsed.data.fencingToken,
      parsed.data.cursor,
      Date.now(),
    );
    if (!guard.ok) {
      return reply.status(409).send({ error: 'cursor advance rejected', reason: guard.reason, state: guard.state });
    }
    if (state !== null) broadcastSession(state);
    return reply.send(state);
  });

  // Add an investigation note (NOT lease-gated; deterministically merged).
  app.post('/api/sessions/:id/notes', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = AddNoteRequest.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'invalid note request' });
    }
    try {
      const state = addNote(ledger, id, parsed.data.note, Date.now());
      broadcastSession(state);
      return reply.status(201).send(state);
    } catch (e) {
      if (e instanceof SessionError) return reply.status(sessionErrorStatus(e.code)).send({ error: e.message, code: e.code });
      throw e;
    }
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

  // Push a full session state to every follower so they converge immediately.
  function broadcastSession(state: SessionState): void {
    const msg: SessionSignal = { type: 'session', contractVersion: CONTRACT_VERSION, state };
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
