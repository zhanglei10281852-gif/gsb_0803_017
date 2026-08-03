import type {
  IncidentSnapshot,
  ProjectionView,
  ProjectedSpan,
  SnapshotComparison,
  SpanDelta,
  SpanFacet,
} from './contract';
import { CONTRACT_VERSION } from './contract';

/**
 * Build the canonical, deterministic content string that a snapshot's digest is
 * taken over. It depends ONLY on ledger-derived facts (the reproduced view) and
 * the sealed cursor / high-water — never on wall-clock time or map iteration
 * order. Spans and edges are sorted so the same frozen ledger slice always
 * produces byte-identical content, hence an identical digest across restarts.
 */
export function canonicalSnapshotContent(input: {
  label: string;
  note: string | null;
  cursor: { eventTimeMs: number; ingestSequence: number };
  ledgerHighWater: number;
  view: ProjectionView;
}): string {
  const spans = [...input.view.spans]
    .sort(compareSpanKey)
    .map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      service: s.service,
      operation: s.operation,
      status: s.status,
      revision: s.revision,
      ingestSequence: s.ingestSequence,
      eventTimeMs: s.eventTimeMs,
      durationMs: s.durationMs,
      errorKind: s.errorKind,
      onErrorPath: s.onErrorPath,
    }));
  const edges = [...input.view.edges].sort((a, b) =>
    a.fromSpanId === b.fromSpanId
      ? a.toSpanId.localeCompare(b.toSpanId)
      : a.fromSpanId.localeCompare(b.fromSpanId),
  );
  // A fixed-key, ordered object serialized with JSON.stringify is canonical
  // because every field here is already deterministic and arrays are pre-sorted.
  return JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    label: input.label,
    note: input.note,
    cursor: { eventTimeMs: input.cursor.eventTimeMs, ingestSequence: input.cursor.ingestSequence },
    ledgerHighWater: input.ledgerHighWater,
    spans,
    edges,
  });
}

function compareSpanKey(a: ProjectedSpan, b: ProjectedSpan): number {
  if (a.traceId !== b.traceId) return a.traceId.localeCompare(b.traceId);
  return a.spanId.localeCompare(b.spanId);
}

function facetOf(s: ProjectedSpan): SpanFacet {
  return {
    service: s.service,
    operation: s.operation,
    status: s.status,
    revision: s.revision,
    onErrorPath: s.onErrorPath,
    errorKind: s.errorKind,
  };
}

function keyOf(s: { traceId: string; spanId: string }): string {
  return `${s.traceId}\u0000${s.spanId}`;
}

/**
 * Deterministically diff two reproduced snapshot views (A -> B). Reports spans
 * that appeared, disappeared, changed status, changed revision, or moved on/off
 * the error (critical) path. Pure and order-independent: inputs are keyed and
 * outputs are sorted, so the same pair of snapshots always compares identically.
 */
export function diffSnapshotViews(
  from: IncidentSnapshot,
  fromView: ProjectionView,
  to: IncidentSnapshot,
  toView: ProjectionView,
): SnapshotComparison {
  const a = new Map(fromView.spans.map((s) => [keyOf(s), s]));
  const b = new Map(toView.spans.map((s) => [keyOf(s), s]));

  const added: SpanDelta[] = [];
  const removed: SpanDelta[] = [];
  const changed: SpanDelta[] = [];

  // Present only in B -> added.
  for (const [key, s] of b) {
    if (!a.has(key)) {
      added.push({
        traceId: s.traceId,
        spanId: s.spanId,
        service: s.service,
        operation: s.operation,
        presence: 'added',
        statusChanged: false,
        revisionChanged: false,
        pathChanged: false,
        before: null,
        after: facetOf(s),
      });
    }
  }

  // Present only in A -> removed. Present in both -> maybe changed.
  for (const [key, sa] of a) {
    const sb = b.get(key);
    if (sb === undefined) {
      removed.push({
        traceId: sa.traceId,
        spanId: sa.spanId,
        service: sa.service,
        operation: sa.operation,
        presence: 'removed',
        statusChanged: false,
        revisionChanged: false,
        pathChanged: false,
        before: facetOf(sa),
        after: null,
      });
      continue;
    }
    const statusChanged = sa.status !== sb.status;
    const revisionChanged = sa.revision !== sb.revision;
    const pathChanged = sa.onErrorPath !== sb.onErrorPath;
    if (statusChanged || revisionChanged || pathChanged) {
      changed.push({
        traceId: sb.traceId,
        spanId: sb.spanId,
        service: sb.service,
        operation: sb.operation,
        presence: 'changed',
        statusChanged,
        revisionChanged,
        pathChanged,
        before: facetOf(sa),
        after: facetOf(sb),
      });
    }
  }

  added.sort(byKey);
  removed.sort(byKey);
  changed.sort(byKey);

  return {
    contractVersion: CONTRACT_VERSION,
    from,
    to,
    added,
    removed,
    changed,
    summary: {
      added: added.length,
      removed: removed.length,
      statusChanged: changed.filter((d) => d.statusChanged).length,
      pathChanged: changed.filter((d) => d.pathChanged).length,
      revisionChanged: changed.filter((d) => d.revisionChanged).length,
    },
  };
}

function byKey(a: SpanDelta, b: SpanDelta): number {
  if (a.traceId !== b.traceId) return a.traceId.localeCompare(b.traceId);
  return a.spanId.localeCompare(b.spanId);
}
