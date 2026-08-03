import { useEffect, useMemo, useRef, useState } from "react";
import type { SpanSummaryV1 } from "@replay/shared";
import type { Selection } from "../state.js";

export interface SpanListProps {
  spans: readonly SpanSummaryV1[];
  selection: Selection | null;
  serviceFilter: string | null;
  domainMin: number;
  onSelect(traceId: string, spanId: string): void;
  onClearServiceFilter(): void;
}

export function SpanList(props: SpanListProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [errorOnly, setErrorOnly] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.spans
      .filter((s) => (props.serviceFilter ? s.service === props.serviceFilter : true))
      .filter((s) => (errorOnly ? s.status === "error" : true))
      .filter((s) =>
        q
          ? s.spanId.toLowerCase().includes(q) ||
            s.traceId.toLowerCase().includes(q) ||
            s.service.toLowerCase().includes(q) ||
            s.operation.toLowerCase().includes(q)
          : true,
      )
      .slice()
      .sort((a, b) => b.eventTime - a.eventTime || b.ingestSequence - a.ingestSequence);
  }, [props.spans, props.serviceFilter, query, errorOnly]);

  useEffect(() => {
    const el = containerRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [props.selection]);

  return (
    <div className="panel-inner" ref={containerRef} data-testid="span-list">
      <div className="panel-header">
        <span>span 列表（{filtered.length}）</span>
        {props.serviceFilter && (
          <button type="button" className="chip chip-btn" data-testid="service-filter" onClick={props.onClearServiceFilter}>
            {props.serviceFilter} ×
          </button>
        )}
      </div>
      <div className="panel-tools">
        <input
          className="input"
          data-testid="filter-input"
          placeholder="按 traceId / spanId / 服务 / 操作过滤"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            data-testid="error-only"
            checked={errorOnly}
            onChange={(e) => setErrorOnly(e.target.checked)}
          />
          仅看错误
        </label>
      </div>
      <div className="span-rows">
        {filtered.map((s) => {
          const selected = props.selection?.spanId === s.spanId && props.selection.traceId === s.traceId;
          return (
            <button
              type="button"
              key={`${s.traceId}/${s.spanId}`}
              className={`span-row${selected ? " selected" : ""}`}
              data-testid={`span-row-${s.spanId}`}
              data-selected={selected}
              onClick={() => props.onSelect(s.traceId, s.spanId)}
            >
              <span className={`dot ${s.status}`} />
              <span className="span-service">{s.service}</span>
              <span className="span-op">{s.operation}</span>
              <span className={`badge${s.versionCount > 1 ? " badge-warn" : ""}`}>
                r{s.revision}
                {s.versionCount > 1 ? `/${s.versionCount}版` : ""}
              </span>
              <span className="mono span-time">+{((s.eventTime - props.domainMin) / 1000).toFixed(1)}s</span>
              <span className="mono span-seq">#{s.ingestSequence}</span>
            </button>
          );
        })}
        {filtered.length === 0 && <div className="empty">当前游标/过滤条件下没有可见 span</div>}
      </div>
    </div>
  );
}
