import type {
  CollaborationLease,
  InvestigationNote,
  ParticipantRole,
  ReplayCursor,
  SessionState,
} from './contract';

/** Default lease time-to-live (ms) when a client does not specify one. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** A lease is active only while it exists and has not expired at `nowMs`. */
export function isLeaseActive(lease: CollaborationLease | null, nowMs: number): boolean {
  return lease !== null && lease.expiresAtMs > nowMs;
}

/**
 * Deterministically merge investigation notes. Concurrent notes are NOT
 * last-writer-wins: they are unioned by id and totally ordered by
 * (lamport, author, id). The same set of notes therefore converges to an
 * identical ordering on every client, regardless of arrival order, duplicates,
 * or which shift wrote first.
 *
 * If the same id appears twice (e.g. a re-send), the copy with the higher
 * lamport wins, then higher createdAtMs, so idempotent re-sends are stable.
 */
export function mergeNotes(
  existing: readonly InvestigationNote[],
  incoming: readonly InvestigationNote[],
): InvestigationNote[] {
  const byId = new Map<string, InvestigationNote>();
  for (const n of [...existing, ...incoming]) {
    const prev = byId.get(n.id);
    if (prev === undefined || supersedesNote(n, prev)) byId.set(n.id, n);
  }
  return [...byId.values()].sort(compareNotes);
}

function supersedesNote(a: InvestigationNote, b: InvestigationNote): boolean {
  if (a.lamport !== b.lamport) return a.lamport > b.lamport;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs > b.createdAtMs;
  // Fully deterministic tie-break so the merge is total and stable.
  return a.body > b.body;
}

/** Total order used to render merged notes identically everywhere. */
export function compareNotes(a: InvestigationNote, b: InvestigationNote): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.author !== b.author) return a.author.localeCompare(b.author);
  return a.id.localeCompare(b.id);
}

/** Next Lamport clock value given the notes seen so far and a local counter. */
export function nextLamport(localClock: number, notes: readonly InvestigationNote[]): number {
  let max = localClock;
  for (const n of notes) if (n.lamport > max) max = n.lamport;
  return max + 1;
}

/**
 * Classify how the local client relates to the session, for the UI's three
 * required states plus `owner`:
 *
 * - `owner`      : this client holds the active lease (may seal / advance).
 * - `lost-lease` : this client *had* the lease but it expired or was taken over
 *                  by a newer holder/fencing token — it must stop writing.
 * - `following`  : not the owner, and choosing to track the owner's cursor.
 * - `independent`: not the owner, and browsing on its own cursor.
 */
export function classifyRole(input: {
  state: SessionState;
  localHolder: string | null;
  localFencingToken: number | null;
  followOwner: boolean;
  nowMs: number;
}): ParticipantRole {
  const { state, localHolder, localFencingToken, followOwner, nowMs } = input;
  const active = isLeaseActive(state.lease, nowMs);

  if (
    active &&
    localHolder !== null &&
    state.lease !== null &&
    state.lease.holder === localHolder &&
    localFencingToken === state.lease.fencingToken
  ) {
    return 'owner';
  }

  // This client believes it once held a lease (has a token) but no longer is
  // the recognised owner: expired, released, or fenced out by a newer token.
  if (localFencingToken !== null) {
    const supersededByNewer =
      state.highestFencingToken > localFencingToken ||
      state.lease === null ||
      (state.lease !== null && state.lease.holder !== localHolder) ||
      !active;
    if (supersededByNewer) return 'lost-lease';
  }

  return followOwner ? 'following' : 'independent';
}

/** The cursor the UI should display given role + follow choice. */
export function effectiveCursor(input: {
  role: ParticipantRole;
  followOwner: boolean;
  sharedCursor: ReplayCursor;
  localCursor: ReplayCursor;
}): ReplayCursor {
  // Followers (and a fresh follower who just lost the lease but still follows)
  // track the shared cursor; owners and independents use their local cursor.
  if (input.role === 'following') return input.sharedCursor;
  return input.localCursor;
}
