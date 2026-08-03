/**
 * A/B 游标差异：直接比较 buildView 在两个游标处的输出，
 * 复用同一视图管线，不引入旁路数据模型。
 */
import type {
  DiffSummaryV1,
  EdgeChangeV1,
  ErrorPathChangeV1,
  ReplayCursorV1,
  ReplayViewV1,
  SnapshotDiffV1,
  SpanChangeV1,
  SpanSummaryV1,
} from "./contract.js";

/** 键序无关的稳定 JSON 序列化：同一值在任何进程都得到同一字符串。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

/** 摘要输入：服务端对其 stableStringify 后做 sha256，即快照 digest。 */
export function snapshotDigestInput(
  cursorA: ReplayCursorV1,
  cursorB: ReplayCursorV1,
  diff: SnapshotDiffV1,
): unknown {
  return { contract: "snapshot-digest/1", cursorA, cursorB, diff };
}

function describeSpanChanges(a: SpanSummaryV1, b: SpanSummaryV1): string[] {
  const changes: string[] = [];
  if (a.revision !== b.revision) changes.push(`修订 r${a.revision} → r${b.revision}`);
  if (a.status !== b.status) changes.push(`状态 ${a.status} → ${b.status}`);
  if (a.errorMessage !== b.errorMessage) {
    changes.push(`错误信息：${a.errorMessage ?? "无"} → ${b.errorMessage ?? "无"}`);
  }
  if (a.eventTime !== b.eventTime) changes.push(`eventTime ${a.eventTime} → ${b.eventTime}`);
  if (a.durationMs !== b.durationMs) changes.push(`耗时 ${a.durationMs}ms → ${b.durationMs}ms`);
  if (a.ingestSequence !== b.ingestSequence) {
    changes.push(`生效 ingest #${a.ingestSequence} → #${b.ingestSequence}`);
  }
  if (a.versionCount !== b.versionCount) {
    changes.push(`可见版本数 ${a.versionCount} → ${b.versionCount}`);
  }
  return changes;
}

function spanKey(traceId: string, spanId: string): string {
  return `${traceId} ${spanId}`;
}

export function diffViews(viewA: ReplayViewV1, viewB: ReplayViewV1): SnapshotDiffV1 {
  const byA = new Map<string, SpanSummaryV1>();
  for (const s of viewA.spans) byA.set(spanKey(s.traceId, s.spanId), s);
  const byB = new Map<string, SpanSummaryV1>();
  for (const s of viewB.spans) byB.set(spanKey(s.traceId, s.spanId), s);

  const spanChanges: SpanChangeV1[] = [];
  const keys = new Set<string>([...byA.keys(), ...byB.keys()]);
  for (const key of keys) {
    const a = byA.get(key);
    const b = byB.get(key);
    if (a && !b) {
      spanChanges.push({
        traceId: a.traceId,
        spanId: a.spanId,
        kind: "removed",
        service: a.service,
        operation: a.operation,
        before: a,
        after: null,
        changes: ["B 游标处不再可见"],
      });
    } else if (!a && b) {
      spanChanges.push({
        traceId: b.traceId,
        spanId: b.spanId,
        kind: "added",
        service: b.service,
        operation: b.operation,
        before: null,
        after: b,
        changes: ["A 游标处不可见，B 游标处出现"],
      });
    } else if (a && b) {
      const changes = describeSpanChanges(a, b);
      if (changes.length > 0) {
        spanChanges.push({
          traceId: a.traceId,
          spanId: a.spanId,
          kind: "changed",
          service: b.service,
          operation: b.operation,
          before: a,
          after: b,
          changes,
        });
      }
    }
  }
  spanChanges.sort((x, y) => spanKey(x.traceId, x.spanId).localeCompare(spanKey(y.traceId, y.spanId)));

  const edgeChanges: EdgeChangeV1[] = [];
  const edgeKey = (from: string, to: string): string => `${from} ${to}`;
  const edgesA = new Map(viewA.edges.map((e) => [edgeKey(e.fromService, e.toService), e] as const));
  const edgesB = new Map(viewB.edges.map((e) => [edgeKey(e.fromService, e.toService), e] as const));
  const allEdgeKeys = new Set<string>([...edgesA.keys(), ...edgesB.keys()]);
  for (const key of allEdgeKeys) {
    const a = edgesA.get(key);
    const b = edgesB.get(key);
    if (a && !b) {
      edgeChanges.push({
        fromService: a.fromService,
        toService: a.toService,
        kind: "removed",
        before: { callCount: a.callCount, errorCount: a.errorCount },
        after: null,
        changes: ["B 游标处该调用边消失"],
      });
    } else if (!a && b) {
      edgeChanges.push({
        fromService: b.fromService,
        toService: b.toService,
        kind: "added",
        before: null,
        after: { callCount: b.callCount, errorCount: b.errorCount },
        changes: ["A 游标处不存在，B 游标处出现"],
      });
    } else if (a && b) {
      const changes: string[] = [];
      if (a.callCount !== b.callCount) changes.push(`调用数 ${a.callCount} → ${b.callCount}`);
      if (a.errorCount !== b.errorCount) changes.push(`错误数 ${a.errorCount} → ${b.errorCount}`);
      if (changes.length > 0) {
        edgeChanges.push({
          fromService: a.fromService,
          toService: a.toService,
          kind: "changed",
          before: { callCount: a.callCount, errorCount: a.errorCount },
          after: { callCount: b.callCount, errorCount: b.errorCount },
          changes,
        });
      }
    }
  }
  edgeChanges.sort((x, y) =>
    edgeKey(x.fromService, x.toService).localeCompare(edgeKey(y.fromService, y.toService)),
  );

  const traceIds = new Set<string>();
  for (const s of viewA.spans) traceIds.add(s.traceId);
  for (const s of viewB.spans) traceIds.add(s.traceId);
  const errorPathChanges: ErrorPathChangeV1[] = [];
  for (const traceId of traceIds) {
    const before = viewA.spans
      .filter((s) => s.traceId === traceId && s.status === "error")
      .map((s) => s.spanId)
      .sort();
    const after = viewB.spans
      .filter((s) => s.traceId === traceId && s.status === "error")
      .map((s) => s.spanId)
      .sort();
    if (before.join(" ") !== after.join(" ")) {
      errorPathChanges.push({
        traceId,
        beforeErrorSpanIds: before,
        afterErrorSpanIds: after,
        gainedSpanIds: after.filter((x) => !before.includes(x)),
        lostSpanIds: before.filter((x) => !after.includes(x)),
      });
    }
  }
  errorPathChanges.sort((x, y) => x.traceId.localeCompare(y.traceId));

  const summary: DiffSummaryV1 = {
    added: spanChanges.filter((c) => c.kind === "added").length,
    removed: spanChanges.filter((c) => c.kind === "removed").length,
    changed: spanChanges.filter((c) => c.kind === "changed").length,
    statusFlips: spanChanges.filter(
      (c) => c.kind === "changed" && c.before !== null && c.after !== null && c.before.status !== c.after.status,
    ).length,
    edgesAdded: edgeChanges.filter((c) => c.kind === "added").length,
    edgesRemoved: edgeChanges.filter((c) => c.kind === "removed").length,
    edgesChanged: edgeChanges.filter((c) => c.kind === "changed").length,
    errorPathTraces: errorPathChanges.length,
  };

  return {
    contract: "snapshot-diff/1",
    cursorA: viewA.cursor,
    cursorB: viewB.cursor,
    spanChanges,
    edgeChanges,
    errorPathChanges,
    summary,
  };
}
