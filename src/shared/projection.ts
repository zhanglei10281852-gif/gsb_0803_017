import type {
  LedgerRecord,
  ProjectedEdge,
  ProjectedSpan,
  ProjectionView,
  ReplayCursor,
  VersionReason,
} from './contract';
import { CONTRACT_VERSION } from './contract';

/**
 * Ledger bounds describe the extent of all known facts. They are cursor
 * independent so the UI can render a stable timeline while scrubbing.
 */
export interface LedgerBounds {
  minEventTimeMs: number;
  maxEventTimeMs: number;
  maxIngestSequence: number;
}

export function computeBounds(records: readonly LedgerRecord[]): LedgerBounds {
  let minEventTimeMs = Number.POSITIVE_INFINITY;
  let maxEventTimeMs = 0;
  let maxIngestSequence = 0;
  for (const r of records) {
    if (r.eventTimeMs < minEventTimeMs) minEventTimeMs = r.eventTimeMs;
    if (r.eventTimeMs > maxEventTimeMs) maxEventTimeMs = r.eventTimeMs;
    if (r.ingestSequence > maxIngestSequence) maxIngestSequence = r.ingestSequence;
  }
  if (!Number.isFinite(minEventTimeMs)) minEventTimeMs = 0;
  return { minEventTimeMs, maxEventTimeMs, maxIngestSequence };
}

/** Highest revision that exists for a span anywhere in the ledger. */
function latestRevisionEver(records: readonly LedgerRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    const key = `${r.traceId}\u0000${r.spanId}`;
    const prev = out.get(key);
    if (prev === undefined || r.revision > prev) out.set(key, r.revision);
  }
  return out;
}

interface Winner {
  record: LedgerRecord;
  knownRevisions: number;
}

/**
 * Resolve the current version of every span visible at a cursor.
 *
 * Visibility rule: a record counts only when BOTH
 *   record.ingestSequence <= cursor.ingestSequence  (knowledge had arrived), and
 *   record.eventTimeMs     <= cursor.eventTimeMs     (span is in the scrubbed past).
 *
 * Winner rule: highest `revision` wins; on a revision tie the *earlier*
 * arrival (smaller ingestSequence) wins. This is a total order, so the result
 * is fully deterministic and independent of input ordering -> reproducible
 * regardless of late, duplicate, out-of-order or reconnect arrivals.
 */
function resolveWinners(
  records: readonly LedgerRecord[],
  cursor: ReplayCursor,
): Map<string, Winner> {
  const winners = new Map<string, Winner>();
  const revisionsSeen = new Map<string, Set<number>>();
  for (const r of records) {
    if (r.ingestSequence > cursor.ingestSequence) continue;
    if (r.eventTimeMs > cursor.eventTimeMs) continue;
    const key = `${r.traceId}\u0000${r.spanId}`;
    let revs = revisionsSeen.get(key);
    if (!revs) {
      revs = new Set<number>();
      revisionsSeen.set(key, revs);
    }
    revs.add(r.revision);
    const current = winners.get(key);
    if (current === undefined || beats(r, current.record)) {
      winners.set(key, { record: r, knownRevisions: 0 });
    }
  }
  // knownRevisions counts distinct revision values, so an exact duplicate
  // re-send never inflates the "how many versions are visible" tally.
  for (const [key, w] of winners) w.knownRevisions = revisionsSeen.get(key)?.size ?? 1;
  return winners;
}

/** Strict "a supersedes b" ordering used to pick the current version. */
function beats(a: LedgerRecord, b: LedgerRecord): boolean {
  if (a.revision !== b.revision) return a.revision > b.revision;
  return a.ingestSequence < b.ingestSequence;
}

/**
 * Build the complete, reproducible view for a cursor from the immutable ledger.
 * Pure: same records + same cursor always yield an identical view.
 */
export function projectView(
  records: readonly LedgerRecord[],
  cursor: ReplayCursor,
): ProjectionView {
  const bounds = computeBounds(records);
  const winners = resolveWinners(records, cursor);
  const latestEver = latestRevisionEver(records);

  // First pass: materialise resolved spans keyed by spanId (per trace).
  const byKey = new Map<string, ProjectedSpan>();
  const childrenByParent = new Map<string, string[]>();

  for (const [key, winner] of winners) {
    const r = winner.record;
    const latest = latestEver.get(key) ?? r.revision;
    const supersededLater = latest > r.revision;
    const versionReason: VersionReason = {
      chosenRevision: r.revision,
      chosenIngestSequence: r.ingestSequence,
      knownRevisions: winner.knownRevisions,
      latestRevisionEver: latest,
      supersededLater,
      explanation: explain(r, winner.knownRevisions, latest, supersededLater),
    };
    const span: ProjectedSpan = {
      traceId: r.traceId,
      spanId: r.spanId,
      parentSpanId: r.parentSpanId,
      service: r.service,
      operation: r.operation,
      status: r.status,
      revision: r.revision,
      eventTimeMs: r.eventTimeMs,
      durationMs: r.durationMs,
      ingestSequence: r.ingestSequence,
      errorKind: r.errorKind,
      revisionReason: r.revisionReason,
      onErrorPath: false,
      versionReason,
    };
    byKey.set(key, span);
    if (r.parentSpanId !== null) {
      const parentKey = `${r.traceId}\u0000${r.parentSpanId}`;
      const list = childrenByParent.get(parentKey);
      if (list) list.push(key);
      else childrenByParent.set(parentKey, [key]);
    }
  }

  // Second pass: propagate error state upward from any errored span to its
  // ancestors so the topology highlights the full error path.
  for (const span of byKey.values()) {
    if (span.status === 'error') markAncestorsOnErrorPath(span, byKey);
  }
  // A span in error is itself on the error path.
  for (const span of byKey.values()) {
    if (span.status === 'error') span.onErrorPath = true;
  }

  // Build edges from resolved parent/child relationships.
  const edges: ProjectedEdge[] = [];
  for (const [parentKey, childKeys] of childrenByParent) {
    const parent = byKey.get(parentKey);
    if (!parent) continue; // parent not yet visible at this cursor
    for (const childKey of childKeys) {
      const child = byKey.get(childKey);
      if (!child) continue;
      edges.push({
        fromSpanId: parent.spanId,
        toSpanId: child.spanId,
        propagatesError: child.onErrorPath,
      });
    }
  }

  const spans = [...byKey.values()].sort(spanOrder);
  edges.sort((a, b) =>
    a.fromSpanId === b.fromSpanId
      ? a.toSpanId.localeCompare(b.toSpanId)
      : a.fromSpanId.localeCompare(b.fromSpanId),
  );
  const services = [...new Set(spans.map((s) => s.service))].sort();

  return {
    contractVersion: CONTRACT_VERSION,
    cursor,
    spans,
    edges,
    services,
    bounds,
  };
}

function markAncestorsOnErrorPath(
  span: ProjectedSpan,
  byKey: Map<string, ProjectedSpan>,
): void {
  let cursorSpan: ProjectedSpan | undefined = span;
  const guard = new Set<string>();
  while (cursorSpan && cursorSpan.parentSpanId !== null) {
    const parentKey = `${cursorSpan.traceId}\u0000${cursorSpan.parentSpanId}`;
    if (guard.has(parentKey)) break; // cycle guard
    guard.add(parentKey);
    const parent = byKey.get(parentKey);
    if (!parent) break;
    parent.onErrorPath = true;
    cursorSpan = parent;
  }
}

function spanOrder(a: ProjectedSpan, b: ProjectedSpan): number {
  if (a.traceId !== b.traceId) return a.traceId.localeCompare(b.traceId);
  if (a.eventTimeMs !== b.eventTimeMs) return a.eventTimeMs - b.eventTimeMs;
  return a.spanId.localeCompare(b.spanId);
}

function explain(
  r: LedgerRecord,
  knownRevisions: number,
  latest: number,
  supersededLater: boolean,
): string {
  const parts: string[] = [];
  parts.push(
    `Showing revision ${r.revision} (ingest #${r.ingestSequence}) — the highest revision known at this cursor.`,
  );
  if (knownRevisions > 1) {
    parts.push(`${knownRevisions} revisions of this span are visible here.`);
  }
  if (r.revisionReason) parts.push(`Reason: ${r.revisionReason}.`);
  if (supersededLater) {
    parts.push(
      `A newer revision ${latest} exists but arrived beyond this replay position, so it is intentionally hidden.`,
    );
  }
  return parts.join(' ');
}
