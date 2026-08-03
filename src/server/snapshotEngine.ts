import { createHash } from 'crypto';
import {
  CriticalPathDiff,
  CriticalPathChangeKind,
  CurrentSpan,
  ErrorPropagationPath,
  IncidentDiff,
  IncidentSnapshot,
  LedgerRecord,
  ReplayCursor,
  SnapshotDigest,
  SpanDiffEntry,
  SpanDiffKind,
  SpanStatus
} from '../shared/contracts';
import { ReplayEngine } from './replayEngine';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function canonicalAttributes(attrs: LedgerRecord['attributes']): unknown {
  const keys = Object.keys(attrs).sort();
  const result: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function canonicalRecord(record: LedgerRecord): unknown {
  return {
    ingestSequence: record.ingestSequence,
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    service: record.service,
    operation: record.operation,
    kind: record.kind,
    status: record.status,
    startTime: record.startTime,
    endTime: record.endTime,
    revision: record.revision,
    eventTime: record.eventTime,
    errorMessage: record.errorMessage,
    attributes: canonicalAttributes(record.attributes)
  };
}

function canonicalCurrentSpan(span: CurrentSpan): unknown {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    service: span.service,
    operation: span.operation,
    kind: span.kind,
    status: span.status,
    startTime: span.startTime,
    endTime: span.endTime,
    revision: span.revision,
    eventTime: span.eventTime,
    errorMessage: span.errorMessage,
    attributes: canonicalAttributes(span.attributes)
  };
}

function canonicalErrorPath(path: ErrorPropagationPath): unknown {
  return {
    traceId: path.traceId,
    originSpanId: path.originSpanId,
    path: [...path.path],
    affectedServices: [...path.affectedServices]
  };
}

function visibleRecordsAt(records: readonly LedgerRecord[], cursor: ReplayCursor): LedgerRecord[] {
  return records
    .filter((r) => r.ingestSequence <= cursor.ingestSequence && r.eventTime <= cursor.eventTime)
    .slice()
    .sort((a, b) => a.ingestSequence - b.ingestSequence);
}

export function computeDigest(
  engine: ReplayEngine,
  cursor: ReplayCursor,
  records: readonly LedgerRecord[]
): SnapshotDigest {
  const visible = visibleRecordsAt(records, cursor);
  const recordsDigest = sha256(JSON.stringify(visible.map(canonicalRecord)));

  const view = engine.buildView(cursor, false, 0);
  const fingerprintPayload = {
    spans: view.spans.map(canonicalCurrentSpan),
    errorPaths: view.errorPaths.map(canonicalErrorPath)
  };
  const viewFingerprint = sha256(JSON.stringify(fingerprintPayload));

  const bounds = engine.ledgerBounds;
  return {
    ledgerHighWatermark: {
      maxIngestSequence: bounds.maxIngest,
      maxEventTime: bounds.maxEvent,
      totalRecords: records.length
    },
    cursor: { eventTime: cursor.eventTime, ingestSequence: cursor.ingestSequence },
    visibleRecordCount: visible.length,
    recordsDigest,
    viewFingerprint,
    spanCount: view.spans.length,
    traceCount: view.traces.length,
    errorPathCount: view.errorPaths.length
  };
}

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`;
}

function statusLabel(status: SpanStatus | null): string {
  return status ?? '∅';
}

function makeEntry(
  before: CurrentSpan | null,
  after: CurrentSpan | null,
  kind: SpanDiffKind
): SpanDiffEntry {
  const reference = before ?? after;
  if (!reference) throw new Error('diff entry requires at least one side');
  let detail: string;
  if (kind === 'added') {
    detail = `appeared at revision ${after!.revision} (${after!.service}/${after!.operation})`;
  } else if (kind === 'removed') {
    detail = `no longer present (was revision ${before!.revision}, ${before!.status})`;
  } else if (kind === 'status-changed') {
    detail = `status ${statusLabel(before!.status)} → ${statusLabel(after!.status)}`;
  } else {
    detail = `revision r${before!.revision} → r${after!.revision}`;
  }
  return {
    traceId: reference.traceId,
    spanId: reference.spanId,
    service: reference.service,
    operation: reference.operation,
    kind,
    beforeRevision: before ? before.revision : null,
    afterRevision: after ? after.revision : null,
    beforeStatus: before ? before.status : null,
    afterStatus: after ? after.status : null,
    beforeErrorMessage: before ? before.errorMessage : null,
    afterErrorMessage: after ? after.errorMessage : null,
    detail
  };
}

function diffSpans(viewA: ReturnType<ReplayEngine['buildView']>, viewB: ReturnType<ReplayEngine['buildView']>): {
  added: SpanDiffEntry[];
  removed: SpanDiffEntry[];
  statusChanged: SpanDiffEntry[];
  revisionChanged: SpanDiffEntry[];
} {
  const mapA = new Map<string, CurrentSpan>();
  for (const span of viewA.spans) mapA.set(spanKey(span.traceId, span.spanId), span);
  const mapB = new Map<string, CurrentSpan>();
  for (const span of viewB.spans) mapB.set(spanKey(span.traceId, span.spanId), span);

  const added: SpanDiffEntry[] = [];
  const removed: SpanDiffEntry[] = [];
  const statusChanged: SpanDiffEntry[] = [];
  const revisionChanged: SpanDiffEntry[] = [];

  for (const [key, after] of mapB) {
    const before = mapA.get(key);
    if (!before) {
      added.push(makeEntry(null, after, 'added'));
    } else if (before.status !== after.status || before.errorMessage !== after.errorMessage) {
      statusChanged.push(makeEntry(before, after, 'status-changed'));
    } else if (before.revision !== after.revision) {
      revisionChanged.push(makeEntry(before, after, 'revision-changed'));
    }
  }
  for (const [key, before] of mapA) {
    if (!mapB.has(key)) removed.push(makeEntry(before, null, 'removed'));
  }

  const byKey = (a: SpanDiffEntry, b: SpanDiffEntry) => a.spanId.localeCompare(b.spanId);
  return {
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    statusChanged: statusChanged.sort(byKey),
    revisionChanged: revisionChanged.sort(byKey)
  };
}

function diffCriticalPaths(
  viewA: ReturnType<ReplayEngine['buildView']>,
  viewB: ReturnType<ReplayEngine['buildView']>
): CriticalPathDiff[] {
  const mapA = new Map<string, ErrorPropagationPath>();
  for (const path of viewA.errorPaths) {
    mapA.set(spanKey(path.traceId, path.originSpanId), path);
  }
  const mapB = new Map<string, ErrorPropagationPath>();
  for (const path of viewB.errorPaths) {
    mapB.set(spanKey(path.traceId, path.originSpanId), path);
  }

  const changes: CriticalPathDiff[] = [];
  for (const [key, after] of mapB) {
    const before = mapA.get(key);
    if (!before) {
      changes.push({
        traceId: after.traceId,
        key,
        originSpanId: after.originSpanId,
        beforePath: [],
        afterPath: [...after.path],
        beforeAffectedServices: [],
        afterAffectedServices: [...after.affectedServices],
        change: 'path-extended'
      });
      continue;
    }
    const beforeServices = [...before.affectedServices].join(',');
    const afterServices = [...after.affectedServices].join(',');
    let change: CriticalPathChangeKind;
    if (before.originSpanId !== after.originSpanId) {
      change = 'origin-changed';
    } else if (beforeServices !== afterServices) {
      change = 'service-set-changed';
    } else if (after.path.length > before.path.length) {
      change = 'path-extended';
    } else if (after.path.length < before.path.length) {
      change = 'path-shortened';
    } else {
      continue;
    }
    changes.push({
      traceId: after.traceId,
      key,
      originSpanId: after.originSpanId,
      beforePath: [...before.path],
      afterPath: [...after.path],
      beforeAffectedServices: [...before.affectedServices],
      afterAffectedServices: [...after.affectedServices],
      change
    });
  }
  for (const [key, before] of mapA) {
    if (!mapB.has(key)) {
      changes.push({
        traceId: before.traceId,
        key,
        originSpanId: before.originSpanId,
        beforePath: [...before.path],
        afterPath: [],
        beforeAffectedServices: [...before.affectedServices],
        afterAffectedServices: [],
        change: 'path-shortened'
      });
    }
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

export function diffCursors(
  engine: ReplayEngine,
  cursorA: ReplayCursor,
  cursorB: ReplayCursor
): IncidentDiff {
  const viewA = engine.buildView(cursorA, false, 0);
  const viewB = engine.buildView(cursorB, false, 0);
  const spanDiff = diffSpans(viewA, viewB);
  const criticalPathChanges = diffCriticalPaths(viewA, viewB);
  return {
    ...spanDiff,
    criticalPathChanges,
    summary: {
      addedCount: spanDiff.added.length,
      removedCount: spanDiff.removed.length,
      statusChangedCount: spanDiff.statusChanged.length,
      revisionChangedCount: spanDiff.revisionChanged.length,
      criticalPathChangeCount: criticalPathChanges.length
    }
  };
}

export function buildSnapshot(
  id: string,
  createdAt: number,
  labelA: string,
  labelB: string,
  cursorA: ReplayCursor,
  cursorB: ReplayCursor,
  notes: string,
  engine: ReplayEngine,
  records: readonly LedgerRecord[]
): IncidentSnapshot {
  return {
    contractVersion: 1,
    id,
    createdAt,
    labelA,
    labelB,
    cursorA,
    cursorB,
    digestA: computeDigest(engine, cursorA, records),
    digestB: computeDigest(engine, cursorB, records),
    diff: diffCursors(engine, cursorA, cursorB),
    notes,
    sealed: true
  };
}
