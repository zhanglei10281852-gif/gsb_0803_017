import {
  CONTRACT_VERSION,
  CurrentSpan,
  EffectiveReason,
  ErrorPropagationPath,
  LedgerRecord,
  ReplayCursor,
  ReplayView,
  SpanDetail,
  SpanVersion,
  TopologyEdge,
  TopologyNode,
  TraceSummary
} from '../shared/contracts';

export interface ReplayEngineOptions {
  readonly generatePositions?: boolean;
}

interface WinnerAcc {
  record: LedgerRecord;
  comparedVersions: number;
}

function selectWinner(records: readonly LedgerRecord[]): WinnerAcc | null {
  if (records.length === 0) return null;
  let winner = records[0]!;
  for (let i = 1; i < records.length; i++) {
    const candidate = records[i]!;
    if (candidate.revision > winner.revision) {
      winner = candidate;
    } else if (candidate.revision === winner.revision) {
      if (candidate.ingestSequence < winner.ingestSequence) {
        winner = candidate;
      }
    }
  }
  return { record: winner, comparedVersions: records.length };
}

function buildReason(winner: LedgerRecord, all: readonly LedgerRecord[]): EffectiveReason {
  if (all.length <= 1) {
    return {
      kind: 'first-seen',
      comparedVersions: all.length,
      winningIngestSequence: winner.ingestSequence,
      detail: `revision ${winner.revision} at ingestSequence ${winner.ingestSequence} is the first observed version`
    };
  }
  const others = all.filter((r) => r.ingestSequence !== winner.ingestSequence);
  const higherExists = others.some((r) => r.revision > winner.revision);
  if (higherExists) {
    return {
      kind: 'overwritten-later',
      comparedVersions: all.length,
      winningIngestSequence: winner.ingestSequence,
      detail: 'selected version is not the highest revision; this state should not occur'
    };
  }
  const sameRevisionOthers = others.filter((r) => r.revision === winner.revision);
  if (sameRevisionOthers.length > 0) {
    return {
      kind: 'first-seen',
      comparedVersions: all.length,
      winningIngestSequence: winner.ingestSequence,
      detail: `revision ${winner.revision} observed ${sameRevisionOthers.length + 1} time(s); earliest ingestSequence ${winner.ingestSequence} wins (idempotent duplicate handling)`
    };
  }
  return {
    kind: 'newest-revision',
    comparedVersions: all.length,
    winningIngestSequence: winner.ingestSequence,
    detail: `revision ${winner.revision} is higher than ${others.length} earlier version(s); became current at ingestSequence ${winner.ingestSequence}`
  };
}

function isVisible(record: LedgerRecord, cursor: ReplayCursor): boolean {
  return record.ingestSequence <= cursor.ingestSequence && record.eventTime <= cursor.eventTime;
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildTopology(spans: readonly CurrentSpan[]): {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
} {
  const serviceMap = new Map<string, { spanCount: number; errorCount: number }>();
  for (const span of spans) {
    const entry = serviceMap.get(span.service) ?? { spanCount: 0, errorCount: 0 };
    entry.spanCount += 1;
    if (span.status === 'error') entry.errorCount += 1;
    serviceMap.set(span.service, entry);
  }
  const services = Array.from(serviceMap.keys()).sort();
  const radius = Math.max(6, services.length * 1.8);
  const nodes: TopologyNode[] = services.map((service, index) => {
    const stats = serviceMap.get(service)!;
    const angle = (index / Math.max(services.length, 1)) * Math.PI * 2;
    return {
      id: service,
      service,
      spanCount: stats.spanCount,
      errorCount: stats.errorCount,
      position: {
        x: Math.cos(angle) * radius,
        y: (hashString(service) % 100) / 100 - 0.5,
        z: Math.sin(angle) * radius
      }
    };
  });

  const spanByKey = new Map<string, CurrentSpan>();
  for (const span of spans) {
    spanByKey.set(`${span.traceId}:${span.spanId}`, span);
  }
  const edgeMap = new Map<string, TopologyEdge>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const parent = spanByKey.get(`${span.traceId}:${span.parentSpanId}`);
    if (!parent) continue;
    if (parent.service === span.service) continue;
    const source = parent.service;
    const target = span.service;
    const key = `${source}->${target}`;
    const existing = edgeMap.get(key);
    if (existing) {
      edgeMap.set(key, {
        ...existing,
        callCount: existing.callCount + 1,
        errorCount: existing.errorCount + (span.status === 'error' ? 1 : 0)
      });
    } else {
      edgeMap.set(key, {
        id: key,
        source,
        target,
        callCount: 1,
        errorCount: span.status === 'error' ? 1 : 0
      });
    }
  }
  return { nodes, edges: Array.from(edgeMap.values()).sort((a, b) => a.id.localeCompare(b.id)) };
}

function buildTraceSummaries(spans: readonly CurrentSpan[]): TraceSummary[] {
  const traces = new Map<string, CurrentSpan[]>();
  for (const span of spans) {
    const list = traces.get(span.traceId) ?? [];
    list.push(span);
    traces.set(span.traceId, list);
  }
  const summaries: TraceSummary[] = [];
  for (const [traceId, list] of traces) {
    const services = new Set<string>();
    let errorCount = 0;
    let minStartTime = Number.POSITIVE_INFINITY;
    let maxEndTime = Number.NEGATIVE_INFINITY;
    let rootService: string | null = null;
    const spanIds = new Set(list.map((s) => s.spanId));
    for (const span of list) {
      services.add(span.service);
      if (span.status === 'error') errorCount += 1;
      minStartTime = Math.min(minStartTime, span.startTime);
      maxEndTime = Math.max(maxEndTime, span.endTime);
      if (span.parentSpanId === null || !spanIds.has(span.parentSpanId)) {
        rootService = span.service;
      }
    }
    summaries.push({
      traceId,
      serviceCount: services.size,
      spanCount: list.length,
      errorCount,
      rootService,
      minStartTime,
      maxEndTime
    });
  }
  return summaries.sort((a, b) => a.traceId.localeCompare(b.traceId));
}

function buildErrorPaths(spans: readonly CurrentSpan[]): ErrorPropagationPath[] {
  const byTrace = new Map<string, CurrentSpan[]>();
  for (const span of spans) {
    const list = byTrace.get(span.traceId) ?? [];
    list.push(span);
    byTrace.set(span.traceId, list);
  }
  const paths: ErrorPropagationPath[] = [];
  for (const [traceId, list] of byTrace) {
    const spanMap = new Map<string, CurrentSpan>();
    for (const span of list) spanMap.set(span.spanId, span);
    const errorSpans = list.filter((s) => s.status === 'error');
    if (errorSpans.length === 0) continue;

    for (const errorSpan of errorSpans) {
      const chain: CurrentSpan[] = [];
      let current: CurrentSpan | undefined = errorSpan;
      const guard = new Set<string>();
      while (current && !guard.has(current.spanId)) {
        guard.add(current.spanId);
        chain.unshift(current);
        current = current.parentSpanId ? spanMap.get(current.parentSpanId) : undefined;
      }
      const affectedServices = Array.from(new Set(chain.map((s) => s.service))).sort();
      paths.push({
        traceId,
        path: chain.map((s) => s.spanId),
        originSpanId: errorSpan.spanId,
        originService: errorSpan.service,
        affectedServices
      });
    }
  }
  return paths.sort((a, b) => {
    if (a.traceId !== b.traceId) return a.traceId.localeCompare(b.traceId);
    return a.originSpanId.localeCompare(b.originSpanId);
  });
}

export class ReplayEngine {
  private readonly records: readonly LedgerRecord[];

  constructor(records: readonly LedgerRecord[]) {
    this.records = records;
  }

  static cursorFromRecords(records: readonly LedgerRecord[]): ReplayCursor {
    let maxIngest = 0;
    let maxEvent = 0;
    for (const record of records) {
      if (record.ingestSequence > maxIngest) maxIngest = record.ingestSequence;
      if (record.eventTime > maxEvent) maxEvent = record.eventTime;
    }
    return { eventTime: maxEvent, ingestSequence: maxIngest };
  }

  liveCursor(): ReplayCursor {
    return ReplayEngine.cursorFromRecords(this.records);
  }

  get ledgerBounds() {
    let minIngest = 0;
    let maxIngest = 0;
    let minEvent = 0;
    let maxEvent = 0;
    for (const record of this.records) {
      if (minIngest === 0 || record.ingestSequence < minIngest) minIngest = record.ingestSequence;
      if (record.ingestSequence > maxIngest) maxIngest = record.ingestSequence;
      if (minEvent === 0 || record.eventTime < minEvent) minEvent = record.eventTime;
      if (record.eventTime > maxEvent) maxEvent = record.eventTime;
    }
    return { minIngest, maxIngest, minEvent, maxEvent };
  }

  watermarkAt(ingestSequence: number): number {
    let maxEvent = 0;
    for (const record of this.records) {
      if (record.ingestSequence > ingestSequence) break;
      if (record.eventTime > maxEvent) maxEvent = record.eventTime;
    }
    return maxEvent;
  }

  buildView(cursor: ReplayCursor, live: boolean, now: number = Date.now()): ReplayView {
    const visible = this.records.filter((r) => isVisible(r, cursor));
    const groups = new Map<string, LedgerRecord[]>();
    for (const record of visible) {
      const key = `${record.traceId}:${record.spanId}`;
      const list = groups.get(key) ?? [];
      list.push(record);
      groups.set(key, list);
    }
    const spans: CurrentSpan[] = [];
    for (const [, groupRecords] of groups) {
      const winner = selectWinner(groupRecords);
      if (!winner) continue;
      const reason = buildReason(winner.record, groupRecords);
      spans.push({
        traceId: winner.record.traceId,
        spanId: winner.record.spanId,
        parentSpanId: winner.record.parentSpanId,
        service: winner.record.service,
        operation: winner.record.operation,
        kind: winner.record.kind,
        status: winner.record.status,
        startTime: winner.record.startTime,
        endTime: winner.record.endTime,
        revision: winner.record.revision,
        eventTime: winner.record.eventTime,
        errorMessage: winner.record.errorMessage,
        attributes: winner.record.attributes,
        activeAt: {
          eventTime: winner.record.eventTime,
          ingestSequence: winner.record.ingestSequence
        },
        effectiveReason: reason
      });
    }
    spans.sort((a, b) => {
      if (a.traceId !== b.traceId) return a.traceId.localeCompare(b.traceId);
      if (a.startTime !== b.startTime) return a.startTime - b.startTime;
      return a.spanId.localeCompare(b.spanId);
    });

    const topology = buildTopology(spans);
    const traces = buildTraceSummaries(spans);
    const errorPaths = buildErrorPaths(spans);
    const bounds = this.ledgerBounds;

    return {
      contractVersion: CONTRACT_VERSION,
      cursor,
      live,
      ledgerInfo: {
        totalRecords: this.records.length,
        minIngestSequence: bounds.minIngest,
        maxIngestSequence: bounds.maxIngest,
        minEventTime: bounds.minEvent,
        maxEventTime: bounds.maxEvent
      },
      traces,
      spans,
      topology,
      errorPaths,
      generatedAt: now
    };
  }

  buildSpanDetail(
    traceId: string,
    spanId: string,
    cursor: ReplayCursor
  ): SpanDetail | null {
    const allVersions = this.records.filter(
      (r) => r.traceId === traceId && r.spanId === spanId
    );
    if (allVersions.length === 0) return null;
    const visible = allVersions.filter((r) => isVisible(r, cursor));
    const winner = selectWinner(visible);
    if (!winner) return null;
    const reason = buildReason(winner.record, visible);
    const current: CurrentSpan = {
      traceId: winner.record.traceId,
      spanId: winner.record.spanId,
      parentSpanId: winner.record.parentSpanId,
      service: winner.record.service,
      operation: winner.record.operation,
      kind: winner.record.kind,
      status: winner.record.status,
      startTime: winner.record.startTime,
      endTime: winner.record.endTime,
      revision: winner.record.revision,
      eventTime: winner.record.eventTime,
      errorMessage: winner.record.errorMessage,
      attributes: winner.record.attributes,
      activeAt: { eventTime: winner.record.eventTime, ingestSequence: winner.record.ingestSequence },
      effectiveReason: reason
    };
    const versions: SpanVersion[] = allVersions.map((record) => {
      const visibleAtCursor = isVisible(record, cursor);
      const selectedAtCursor = visibleAtCursor && record.ingestSequence === winner.record.ingestSequence;
      let versionReason: string;
      if (!visibleAtCursor) {
        versionReason = `not yet visible at cursor (ingestSequence ${record.ingestSequence}, eventTime ${record.eventTime})`;
      } else if (selectedAtCursor) {
        versionReason = `current winner: ${reason.detail}`;
      } else if (record.revision > winner.record.revision) {
        versionReason = `higher revision but arrives after cursor ingestSequence ${cursor.ingestSequence}`;
      } else if (record.revision < winner.record.revision) {
        versionReason = `superseded by revision ${winner.record.revision}`;
      } else {
        versionReason = `same revision but later ingestSequence; first-seen wins`;
      }
      return {
        ingestSequence: record.ingestSequence,
        revision: record.revision,
        eventTime: record.eventTime,
        status: record.status,
        service: record.service,
        operation: record.operation,
        errorMessage: record.errorMessage,
        visibleAtCursor,
        selectedAtCursor,
        reason: versionReason
      };
    });
    return { traceId, spanId, current, versions };
  }
}
