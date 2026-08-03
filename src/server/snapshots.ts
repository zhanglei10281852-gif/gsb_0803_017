import { createHash } from 'node:crypto';
import { Ledger, type SnapshotRow } from './ledger';
import { projectView } from '../shared/projection';
import { canonicalSnapshotContent, diffSnapshotViews } from '../shared/snapshot';
import {
  CONTRACT_VERSION,
  type IncidentSnapshot,
  type ProjectionView,
  type ReplayCursor,
  type SealSnapshotRequest,
  type SnapshotComparison,
  type SnapshotView,
} from '../shared/contract';

/**
 * Reproduce the projection a snapshot froze. A snapshot pins the ledger at its
 * `ledgerHighWater`, so we replay ONLY the records that existed at seal time
 * (ingestSequence <= high-water). This is why later/late events can never
 * change a sealed snapshot's view or digest — they are simply out of the slice.
 */
export function reproduceSnapshotView(
  ledger: Ledger,
  cursor: ReplayCursor,
  ledgerHighWater: number,
): ProjectionView {
  const frozen = ledger.readUpToIngest(ledgerHighWater);
  return projectView(frozen, cursor);
}

/** Deterministic sha256 over the canonical, ledger-derived snapshot content. */
export function computeDigest(input: {
  label: string;
  note: string | null;
  cursor: ReplayCursor;
  ledgerHighWater: number;
  view: ProjectionView;
}): string {
  const content = canonicalSnapshotContent(input);
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function rowToSnapshot(row: SnapshotRow): IncidentSnapshot {
  return {
    contractVersion: CONTRACT_VERSION,
    id: row.id,
    label: row.label,
    note: row.note,
    cursor: { eventTimeMs: row.eventTimeMs, ingestSequence: row.ingestSequence },
    provenance: {
      ledgerHighWater: row.ledgerHighWater,
      digestAlgorithm: 'sha256',
      digest: row.digest,
    },
    sealedAtMs: row.sealedAtMs,
  };
}

/**
 * Seal the current cursor into an immutable snapshot. The high-water is taken
 * from the live ledger at this instant; the digest is computed over the view
 * reproduced from that frozen slice, so it is stable across restarts.
 */
export function sealSnapshot(
  ledger: Ledger,
  req: SealSnapshotRequest,
  sealedAtMs: number,
): SnapshotView {
  const ledgerHighWater = ledger.bounds().maxIngestSequence;
  // A snapshot never "sees" more knowledge than existed when it was sealed.
  const cursor: ReplayCursor = {
    eventTimeMs: req.cursor.eventTimeMs,
    ingestSequence: Math.min(req.cursor.ingestSequence, ledgerHighWater),
  };
  const view = reproduceSnapshotView(ledger, cursor, ledgerHighWater);
  const digest = computeDigest({
    label: req.label,
    note: req.note,
    cursor,
    ledgerHighWater,
    view,
  });
  const id = ledger.insertSnapshot({
    contractVersion: CONTRACT_VERSION,
    label: req.label,
    note: req.note,
    eventTimeMs: cursor.eventTimeMs,
    ingestSequence: cursor.ingestSequence,
    ledgerHighWater,
    digestAlgorithm: 'sha256',
    digest,
    sealedAtMs,
  });
  const row = ledger.getSnapshot(id);
  if (row === null) throw new Error('snapshot vanished immediately after insert');
  return { contractVersion: CONTRACT_VERSION, snapshot: rowToSnapshot(row), view };
}

/** Load a sealed snapshot and reproduce its frozen view. */
export function loadSnapshotView(ledger: Ledger, id: number): SnapshotView | null {
  const row = ledger.getSnapshot(id);
  if (row === null) return null;
  const snapshot = rowToSnapshot(row);
  const view = reproduceSnapshotView(ledger, snapshot.cursor, row.ledgerHighWater);
  return { contractVersion: CONTRACT_VERSION, snapshot, view };
}

export function listSnapshots(ledger: Ledger): IncidentSnapshot[] {
  return ledger.listSnapshots().map(rowToSnapshot);
}

/** Deterministically compare two sealed snapshots (A -> B). */
export function compareSnapshots(
  ledger: Ledger,
  fromId: number,
  toId: number,
): SnapshotComparison | null {
  const from = loadSnapshotView(ledger, fromId);
  const to = loadSnapshotView(ledger, toId);
  if (from === null || to === null) return null;
  return diffSnapshotViews(from.snapshot, from.view, to.snapshot, to.view);
}

/**
 * Verify a sealed snapshot still reproduces its recorded digest. Used to prove
 * immutability: after late events arrive, the frozen slice (and thus digest)
 * must be unchanged.
 */
export function verifySnapshotDigest(ledger: Ledger, id: number): boolean {
  const row = ledger.getSnapshot(id);
  if (row === null) return false;
  const snapshot = rowToSnapshot(row);
  const view = reproduceSnapshotView(ledger, snapshot.cursor, row.ledgerHighWater);
  const recomputed = computeDigest({
    label: row.label,
    note: row.note,
    cursor: snapshot.cursor,
    ledgerHighWater: row.ledgerHighWater,
    view,
  });
  return recomputed === row.digest;
}
