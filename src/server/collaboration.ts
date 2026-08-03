import { Ledger, type NoteRow, type SessionRow } from './ledger';
import { loadSnapshotView } from './snapshots';
import { isLeaseActive, mergeNotes, DEFAULT_LEASE_TTL_MS } from '../shared/collaboration';
import {
  CONTRACT_VERSION,
  type CreateSessionRequest,
  type InvestigationNote,
  type ReplayCursor,
  type SessionState,
} from '../shared/contract';

/** Outcome of a write attempt gated by the lease + fencing token. */
export type WriteGuard =
  | { ok: true }
  | { ok: false; reason: 'no-session' | 'no-lease' | 'expired' | 'not-holder' | 'stale-token'; state: SessionState | null };

export class SessionError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'anchor-mismatch' | 'conflict' | 'invalid',
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

function rowToState(ledger: Ledger, row: SessionRow, nowMs: number): SessionState {
  const notes = mergeNotes(
    [],
    ledger.listNotes(row.id).map(noteRowToNote),
  );
  const leaseActive = row.leaseHolder !== null && row.leaseExpiresAtMs !== null && row.leaseToken !== null && row.leaseExpiresAtMs > nowMs;
  return {
    contractVersion: CONTRACT_VERSION,
    session: {
      id: row.id,
      label: row.label,
      anchorSnapshotId: row.anchorSnapshotId,
      anchorDigest: row.anchorDigest,
      createdAtMs: row.createdAtMs,
    },
    lease:
      leaseActive && row.leaseHolder !== null && row.leaseToken !== null && row.leaseExpiresAtMs !== null
        ? { holder: row.leaseHolder, fencingToken: row.leaseToken, expiresAtMs: row.leaseExpiresAtMs }
        : null,
    highestFencingToken: row.highestFencingToken,
    sharedCursor: { eventTimeMs: row.sharedEventTimeMs, ingestSequence: row.sharedIngestSequence },
    sharedCursorToken: row.sharedCursorToken,
    notes,
  };
}

function noteRowToNote(row: NoteRow): InvestigationNote {
  return {
    id: row.noteId,
    author: row.author,
    lamport: row.lamport,
    body: row.body,
    createdAtMs: row.createdAtMs,
  };
}

/**
 * Create a shared session anchored to a sealed snapshot. The anchor digest is
 * verified against the snapshot's recorded digest, so both shifts provably hand
 * off from the same immutable artifact. The shared cursor starts at the
 * snapshot's own cursor.
 */
export function createSession(
  ledger: Ledger,
  req: CreateSessionRequest,
  nowMs: number,
): SessionState {
  const snap = loadSnapshotView(ledger, req.anchorSnapshotId);
  if (snap === null) throw new SessionError('anchor snapshot not found', 'not-found');
  if (snap.snapshot.provenance.digest !== req.anchorDigest) {
    throw new SessionError('anchor digest does not match the sealed snapshot', 'anchor-mismatch');
  }
  const id = ledger.insertSession({
    contractVersion: CONTRACT_VERSION,
    label: req.label,
    anchorSnapshotId: req.anchorSnapshotId,
    anchorDigest: req.anchorDigest,
    createdAtMs: nowMs,
    sharedEventTimeMs: snap.snapshot.cursor.eventTimeMs,
    sharedIngestSequence: snap.snapshot.cursor.ingestSequence,
  });
  const row = ledger.getSession(id);
  if (row === null) throw new SessionError('session vanished after insert', 'invalid');
  return rowToState(ledger, row, nowMs);
}

export function getSessionState(ledger: Ledger, id: number, nowMs: number): SessionState | null {
  const row = ledger.getSession(id);
  return row === null ? null : rowToState(ledger, row, nowMs);
}

/**
 * Acquire (or take over) the lease. Succeeds when the session is free — i.e.
 * nobody holds an *active* lease. Every grant mints a fresh, strictly higher
 * fencing token, so a later takeover always out-ranks the previous holder.
 * Fails with a conflict when an active lease is held by someone else.
 */
export function acquireLease(
  ledger: Ledger,
  sessionId: number,
  holder: string,
  ttlMs: number | undefined,
  nowMs: number,
): SessionState {
  return ledger.transaction(() => {
    const row = ledger.getSession(sessionId);
    if (row === null) throw new SessionError('session not found', 'not-found');
    const activeHeldByOther =
      row.leaseHolder !== null &&
      row.leaseHolder !== holder &&
      row.leaseExpiresAtMs !== null &&
      row.leaseExpiresAtMs > nowMs;
    if (activeHeldByOther) {
      throw new SessionError('lease is actively held by another party', 'conflict');
    }
    const token = row.highestFencingToken + 1; // strictly monotonic
    const ttl = ttlMs ?? DEFAULT_LEASE_TTL_MS;
    ledger.updateSessionState({
      id: row.id,
      leaseHolder: holder,
      leaseExpiresAtMs: nowMs + ttl,
      leaseToken: token,
      highestFencingToken: token,
      sharedEventTimeMs: row.sharedEventTimeMs,
      sharedIngestSequence: row.sharedIngestSequence,
      sharedCursorToken: row.sharedCursorToken,
    });
    const updated = ledger.getSession(row.id)!;
    return rowToState(ledger, updated, nowMs);
  });
}

/** Renew the lease. Only the current holder with the current token may renew. */
export function renewLease(
  ledger: Ledger,
  sessionId: number,
  holder: string,
  fencingToken: number,
  ttlMs: number | undefined,
  nowMs: number,
): SessionState {
  return ledger.transaction(() => {
    const row = ledger.getSession(sessionId);
    if (row === null) throw new SessionError('session not found', 'not-found');
    const isHolder =
      row.leaseHolder === holder &&
      row.leaseToken === fencingToken &&
      row.leaseExpiresAtMs !== null &&
      row.leaseExpiresAtMs > nowMs;
    if (!isHolder) {
      throw new SessionError('cannot renew: lease lost or fencing token superseded', 'conflict');
    }
    const ttl = ttlMs ?? DEFAULT_LEASE_TTL_MS;
    ledger.updateSessionState({
      id: row.id,
      leaseHolder: holder,
      leaseExpiresAtMs: nowMs + ttl,
      leaseToken: fencingToken,
      highestFencingToken: row.highestFencingToken,
      sharedEventTimeMs: row.sharedEventTimeMs,
      sharedIngestSequence: row.sharedIngestSequence,
      sharedCursorToken: row.sharedCursorToken,
    });
    return rowToState(ledger, ledger.getSession(row.id)!, nowMs);
  });
}

/** Release the lease. A stale token is a no-op (someone else already took over). */
export function releaseLease(
  ledger: Ledger,
  sessionId: number,
  holder: string,
  fencingToken: number,
  nowMs: number,
): SessionState {
  return ledger.transaction(() => {
    const row = ledger.getSession(sessionId);
    if (row === null) throw new SessionError('session not found', 'not-found');
    // Only clear the lease if this caller is still the recognised holder.
    if (row.leaseHolder === holder && row.leaseToken === fencingToken) {
      ledger.updateSessionState({
        id: row.id,
        leaseHolder: null,
        leaseExpiresAtMs: null,
        leaseToken: null,
        highestFencingToken: row.highestFencingToken, // never decreases
        sharedEventTimeMs: row.sharedEventTimeMs,
        sharedIngestSequence: row.sharedIngestSequence,
        sharedCursorToken: row.sharedCursorToken,
      });
    }
    return rowToState(ledger, ledger.getSession(row.id)!, nowMs);
  });
}

/**
 * The fencing check used by every writer path (advance cursor, seal snapshot).
 * Rejects a caller that is not the active holder OR whose token is stale — even
 * if the request arrives late, an old client can never overwrite a new owner.
 */
export function checkWriter(
  ledger: Ledger,
  sessionId: number,
  holder: string,
  fencingToken: number,
  nowMs: number,
): WriteGuard {
  const row = ledger.getSession(sessionId);
  if (row === null) return { ok: false, reason: 'no-session', state: null };
  const state = rowToState(ledger, row, nowMs);
  if (row.leaseHolder === null || row.leaseToken === null) {
    return { ok: false, reason: 'no-lease', state };
  }
  if (row.leaseExpiresAtMs === null || row.leaseExpiresAtMs <= nowMs) {
    return { ok: false, reason: 'expired', state };
  }
  if (row.leaseHolder !== holder) return { ok: false, reason: 'not-holder', state };
  // The decisive fencing test: token must be exactly the current lease token.
  if (fencingToken !== row.leaseToken) return { ok: false, reason: 'stale-token', state };
  return { ok: true };
}

/** Advance the shared cursor. Gated by the fencing check. */
export function advanceSharedCursor(
  ledger: Ledger,
  sessionId: number,
  holder: string,
  fencingToken: number,
  cursor: ReplayCursor,
  nowMs: number,
): { guard: WriteGuard; state: SessionState | null } {
  return ledger.transaction(() => {
    const guard = checkWriter(ledger, sessionId, holder, fencingToken, nowMs);
    if (!guard.ok) return { guard, state: guard.state };
    const row = ledger.getSession(sessionId)!;
    ledger.updateSessionState({
      id: row.id,
      leaseHolder: row.leaseHolder,
      leaseExpiresAtMs: row.leaseExpiresAtMs,
      leaseToken: row.leaseToken,
      highestFencingToken: row.highestFencingToken,
      sharedEventTimeMs: cursor.eventTimeMs,
      sharedIngestSequence: cursor.ingestSequence,
      sharedCursorToken: fencingToken,
    });
    return { guard, state: rowToState(ledger, ledger.getSession(row.id)!, nowMs) };
  });
}

/**
 * Add an investigation note. NOT lease-gated: any participant may annotate.
 * Merge is deterministic (see mergeNotes), so concurrent notes converge rather
 * than last-writer-wins.
 */
export function addNote(
  ledger: Ledger,
  sessionId: number,
  note: InvestigationNote,
  nowMs: number,
): SessionState {
  const row = ledger.getSession(sessionId);
  if (row === null) throw new SessionError('session not found', 'not-found');
  ledger.insertNote({
    sessionId,
    noteId: note.id,
    author: note.author,
    lamport: note.lamport,
    body: note.body,
    createdAtMs: note.createdAtMs,
  });
  return rowToState(ledger, ledger.getSession(sessionId)!, nowMs);
}

export { isLeaseActive };
