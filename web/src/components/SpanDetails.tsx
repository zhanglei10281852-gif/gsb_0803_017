import { useEffect, useMemo, useState } from "react";
import type {
  CausalPathV1,
  ReplayCursorV1,
  SpanHistoryV1,
  SpanSummaryV1,
  VersionRole,
} from "@replay/shared";
import { fetchSpanHistory, formatTime } from "../api.js";
import type { Selection } from "../state.js";

export interface SpanDetailsProps {
  selection: Selection | null;
  cursor: ReplayCursorV1;
  spans: readonly SpanSummaryV1[];
  path: CausalPathV1 | null;
}

const ROLE_LABEL: Record<VersionRole, string> = {
  current: "当前生效",
  superseded: "被取代",
  "stale-on-arrival": "迟到旧修订",
  "beyond-cursor": "游标外",
};

export function SpanDetails(props: SpanDetailsProps): React.JSX.Element {
  const [history, setHistory] = useState<SpanHistoryV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(
    () =>
      props.selection
        ? props.spans.find(
            (s) => s.traceId === props.selection?.traceId && s.spanId === props.selection?.spanId,
          ) ?? null
        : null,
    [props.spans, props.selection],
  );

  useEffect(() => {
    const sel = props.selection;
    if (!sel) {
      setHistory(null);
      setError(null);
      return;
    }
    let stale = false;
    setError(null);
    fetchSpanHistory(sel.traceId, sel.spanId, props.cursor)
      .then((h) => {
        if (!stale) setHistory(h);
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stale = true;
    };
  }, [props.selection, props.cursor]);

  if (!props.selection) {
    return (
      <div className="panel-inner" data-testid="details">
        <div className="panel-header">span 详情</div>
        <div className="empty">在列表或三维拓扑中选择一个 span，查看版本生效理由与错误传播路径</div>
      </div>
    );
  }

  const display =
    summary ??
    (history
      ? {
          service: props.selection.spanId,
          operation: "",
          status: "ok" as const,
          errorMessage: null,
          revision: history.currentRevision ?? 0,
          versionCount: history.versions.length,
          eventTime: 0,
          durationMs: 0,
          ingestSequence: 0,
        }
      : null);

  return (
    <div className="panel-inner details" data-testid="details">
      <div className="panel-header">
        <span>
          {summary ? `${summary.service} · ${summary.operation}` : props.selection.spanId}
        </span>
        {summary && <span className={`chip status-${summary.status}`}>{summary.status}</span>}
      </div>
      {display && summary && (
        <div className="detail-grid">
          <span>traceId</span>
          <span className="mono">{props.selection.traceId}</span>
          <span>spanId</span>
          <span className="mono">{props.selection.spanId}</span>
          <span>当前修订</span>
          <span className="mono">
            r{summary.revision}（游标内可见 {summary.versionCount} 版）
          </span>
          <span>eventTime</span>
          <span className="mono">{formatTime(summary.eventTime)}</span>
          <span>耗时</span>
          <span className="mono">{summary.durationMs} ms</span>
          <span>生效 ingest</span>
          <span className="mono">#{summary.ingestSequence}</span>
        </div>
      )}
      {summary?.errorMessage && (
        <div className="error-banner" data-testid="error-banner">
          {summary.errorMessage}
        </div>
      )}
      {props.path && props.path.chain.length > 0 && (
        <div className="causal" data-testid="causal-path">
          <div className="section-title">错误传播 / 因果链</div>
          <div className="causal-chain">
            {props.path.chain.map((s, i) => (
              <span key={s.spanId} className={`causal-node status-${s.status}`}>
                {i > 0 && <span className="causal-arrow">→</span>}
                {s.service}.{s.operation}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="section-title">版本与生效理由</div>
      {error && <div className="empty">历史加载失败：{error}</div>}
      {!error && !history && <div className="empty">加载中…</div>}
      {history && (
        <div className="version-list">
          {history.versions.map((v) => (
            <div
              key={`${v.revision}@${v.ingestSequence}`}
              className={`version-row role-${v.role}`}
              data-testid={`version-row-r${v.revision}-i${v.ingestSequence}`}
            >
              <div className="version-head">
                <span className="mono">r{v.revision}</span>
                <span className="mono">ingest #{v.ingestSequence}</span>
                <span className={`chip role-chip role-${v.role}`} data-testid={`role-r${v.revision}`}>
                  {ROLE_LABEL[v.role]}
                </span>
                <span className={`dot ${v.status}`} />
              </div>
              <div className="version-reason" data-testid={`reason-r${v.revision}`}>
                {v.reason}
              </div>
            </div>
          ))}
          {history.versions.length === 0 && <div className="empty">账本中没有该 span 的版本</div>}
        </div>
      )}
    </div>
  );
}
