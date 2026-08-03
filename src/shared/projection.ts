import {
  type LedgerRecord,
  type ReplayCursor,
  type SpanView,
  type SpanVersionExplanation,
  type ServiceNode,
  type TopologyEdge,
  type TraceSummary,
  type ReplayView,
  emptyHead,
} from './contracts.js';

export function cursorMax(a: ReplayCursor, b: ReplayCursor): ReplayCursor {
  return {
    eventTime: Math.max(a.eventTime, b.eventTime),
    ingestSequence: Math.max(a.ingestSequence, b.ingestSequence),
  };
}

export function isRecordVisible(record: LedgerRecord, cursor: ReplayCursor): boolean {
  return (
    record.event.eventTime <= cursor.eventTime &&
    record.ingestSequence <= cursor.ingestSequence
  );
}

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}\u0000${spanId}`;
}

export function computeHead(records: LedgerRecord[]): ReplayCursor {
  if (records.length === 0) return emptyHead();
  let maxEventTime = 0;
  let maxSeq = 0;
  for (const r of records) {
    if (r.event.eventTime > maxEventTime) maxEventTime = r.event.eventTime;
    if (r.ingestSequence > maxSeq) maxSeq = r.ingestSequence;
  }
  return { eventTime: maxEventTime, ingestSequence: maxSeq };
}

interface CurrentSpan {
  record: LedgerRecord;
}

function selectCurrentVersions(
  records: LedgerRecord[],
): Map<string, CurrentSpan> {
  const current = new Map<string, CurrentSpan>();
  for (const record of records) {
    const key = spanKey(record.event.traceId, record.event.spanId);
    const existing = current.get(key);
    if (existing === undefined) {
      current.set(key, { record });
      continue;
    }
    const eRev = existing.record.event.revision;
    const nRev = record.event.revision;
    if (nRev > eRev) {
      current.set(key, { record });
    } else if (nRev === eRev) {
      if (record.ingestSequence < existing.record.ingestSequence) {
        current.set(key, { record });
      }
    }
  }
  return current;
}

export function projectSpans(records: LedgerRecord[]): SpanView[] {
  const current = selectCurrentVersions(records);
  const views: SpanView[] = [];
  for (const { record } of current.values()) {
    const e = record.event;
    views.push({
      traceId: e.traceId,
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      revision: e.revision,
      eventTime: e.eventTime,
      ingestSequence: record.ingestSequence,
      ingestTime: record.ingestTime,
      service: e.service,
      operation: e.operation,
      status: e.status,
      errorMessage: e.errorMessage,
      attributes: { ...e.attributes },
      arrivalDelayMs: record.ingestTime - e.eventTime,
    });
  }
  views.sort((a, b) => {
    if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
    if (a.traceId !== b.traceId) return a.traceId < b.traceId ? -1 : 1;
    return a.spanId < b.spanId ? -1 : 1;
  });
  return views;
}

export function buildServices(spans: SpanView[]): ServiceNode[] {
  const map = new Map<string, ServiceNode>();
  for (const s of spans) {
    let node = map.get(s.service);
    if (node === undefined) {
      node = { service: s.service, spanCount: 0, errorCount: 0, traceIds: [] };
      map.set(s.service, node);
    }
    node.spanCount++;
    if (s.status === 'error') node.errorCount++;
    if (!node.traceIds.includes(s.traceId)) node.traceIds.push(s.traceId);
  }
  const nodes = [...map.values()];
  nodes.sort((a, b) => a.service.localeCompare(b.service));
  return nodes;
}

export function buildEdges(spans: SpanView[]): TopologyEdge[] {
  const byKey = new Map<string, SpanView>();
  for (const s of spans) {
    byKey.set(spanKey(s.traceId, s.spanId), s);
  }
  const edges: TopologyEdge[] = [];
  for (const s of spans) {
    if (s.parentSpanId === null) continue;
    const parent = byKey.get(spanKey(s.traceId, s.parentSpanId));
    if (parent === undefined) continue;
    edges.push({
      fromService: parent.service,
      toService: s.service,
      traceId: s.traceId,
      parentSpanId: s.parentSpanId,
      spanId: s.spanId,
      hasError: s.status === 'error' || parent.status === 'error',
    });
  }
  edges.sort((a, b) => {
    if (a.traceId !== b.traceId) return a.traceId < b.traceId ? -1 : 1;
    return a.spanId < b.spanId ? -1 : 1;
  });
  return edges;
}

export function buildTraces(spans: SpanView[]): TraceSummary[] {
  const map = new Map<string, SpanView[]>();
  for (const s of spans) {
    let arr = map.get(s.traceId);
    if (arr === undefined) {
      arr = [];
      map.set(s.traceId, arr);
    }
    arr.push(s);
  }
  const traces: TraceSummary[] = [];
  for (const [traceId, arr] of map) {
    let startTime = Infinity;
    let endTime = -Infinity;
    let errorCount = 0;
    const servicesSet = new Set<string>();
    for (const s of arr) {
      if (s.eventTime < startTime) startTime = s.eventTime;
      if (s.eventTime > endTime) endTime = s.eventTime;
      if (s.status === 'error') errorCount++;
      servicesSet.add(s.service);
    }
    const services = [...servicesSet].sort();
    traces.push({
      traceId,
      spanCount: arr.length,
      errorCount,
      services,
      startTime: startTime === Infinity ? 0 : startTime,
      endTime: endTime === -Infinity ? 0 : endTime,
      hasError: errorCount > 0,
    });
  }
  traces.sort((a, b) => a.startTime - b.startTime);
  return traces;
}

export function buildReplayView(
  allRecords: LedgerRecord[],
  cursor: ReplayCursor,
  totalLedgerRecords?: number,
): ReplayView {
  const visible = allRecords.filter((r) => isRecordVisible(r, cursor));
  const spans = projectSpans(visible);
  const head = computeHead(allRecords);
  return {
    cursor,
    head,
    totalLedgerRecords: totalLedgerRecords ?? allRecords.length,
    spans,
    services: buildServices(spans),
    edges: buildEdges(spans),
    traces: buildTraces(spans),
  };
}

export function explainSpanVersions(
  allRecords: LedgerRecord[],
  traceId: string,
  spanId: string,
  cursor: ReplayCursor,
): SpanVersionExplanation[] {
  const versions = allRecords
    .filter(
      (r) =>
        r.event.traceId === traceId &&
        r.event.spanId === spanId &&
        isRecordVisible(r, cursor),
    )
    .sort((a, b) => {
      if (a.event.revision !== b.event.revision) return b.event.revision - a.event.revision;
      return a.ingestSequence - b.ingestSequence;
    });

  const current = versions[0];

  let maxRevisionSeen = -1;
  const becameCurrentMap = new Map<number, number>();
  const arrivalsForSpan = allRecords
    .filter((r) => r.event.traceId === traceId && r.event.spanId === spanId)
    .sort((a, b) => a.ingestSequence - b.ingestSequence);
  for (const r of arrivalsForSpan) {
    if (r.event.revision > maxRevisionSeen) {
      maxRevisionSeen = r.event.revision;
      becameCurrentMap.set(r.event.revision, r.ingestSequence);
    }
  }

  const seenRevisions = new Map<number, LedgerRecord>();
  for (const v of versions) {
    const existing = seenRevisions.get(v.event.revision);
    if (existing === undefined) {
      seenRevisions.set(v.event.revision, v);
    }
  }

  return versions.map((v) => {
    const e = v.event;
    const isCurrent = current !== undefined && v.ingestSequence === current.ingestSequence;
    const isDuplicate = seenRevisions.get(e.revision)?.ingestSequence !== v.ingestSequence;
    const becameCurrentAt = becameCurrentMap.get(e.revision) ?? null;
    const arrivalDelayMs = v.ingestTime - e.eventTime;
    let reason: string;
    if (isCurrent) {
      reason = `Revision ${e.revision} is current at this cursor because it is the highest revision (arrived at ingestSequence ${v.ingestSequence}).`;
    } else if (e.revision < (current?.event.revision ?? -1)) {
      reason = `Revision ${e.revision} is superseded by revision ${current?.event.revision} which arrived at ingestSequence ${current?.ingestSequence}.`;
    } else if (isDuplicate) {
      reason = `Duplicate of revision ${e.revision}; first seen at ingestSequence ${seenRevisions.get(e.revision)?.ingestSequence}. Same revision cannot replace current.`;
    } else {
      reason = `Revision ${e.revision} is visible but not current.`;
    }
    if (arrivalDelayMs > 1000) {
      reason += ` Arrived ${arrivalDelayMs}ms after its eventTime (late).`;
    }
    return {
      traceId,
      spanId,
      revision: e.revision,
      ingestSequence: v.ingestSequence,
      ingestTime: v.ingestTime,
      eventTime: e.eventTime,
      service: e.service,
      operation: e.operation,
      status: e.status,
      errorMessage: e.errorMessage,
      isCurrent,
      isDuplicate,
      becameCurrentAt,
      arrivalDelayMs,
      reason,
    };
  });
}

export function findErrorPropagationPath(
  spans: SpanView[],
  startTraceId: string,
  startSpanId: string,
): SpanView[] {
  const byKey = new Map<string, SpanView>();
  for (const s of spans) {
    byKey.set(spanKey(s.traceId, s.spanId), s);
  }
  const path: SpanView[] = [];
  let current: SpanView | undefined = byKey.get(spanKey(startTraceId, startSpanId));
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(spanKey(current.traceId, current.spanId))) {
    visited.add(spanKey(current.traceId, current.spanId));
    path.push(current);
    if (current.parentSpanId === null) break;
    current = byKey.get(spanKey(current.traceId, current.parentSpanId));
  }
  return path;
}
