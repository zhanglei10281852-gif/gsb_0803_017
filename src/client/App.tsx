import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LiveLedgerEvent,
  ReplayCursor,
  ReplayView,
  SpanDetail as SpanDetailType
} from '../shared/contracts';
import { connectLiveSocket, fetchSpan, fetchView } from './api/client';
import { SpanList } from './components/SpanList';
import { SpanDetailPanel } from './components/SpanDetailPanel';
import { TopologyScene } from './components/TopologyScene';

function formatClock(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  return d.toISOString().slice(11, 23);
}

export default function App() {
  const [view, setView] = useState<ReplayView | null>(null);
  const [live, setLive] = useState(true);
  const [cursorSeq, setCursorSeq] = useState<number>(0);
  const [selected, setSelected] = useState<{ traceId: string; spanId: string } | null>(null);
  const [detail, setDetail] = useState<SpanDetailType | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  const effectiveCursor: ReplayCursor | null = useMemo(() => {
    if (!view) return null;
    if (live) return view.cursor;
    return { ingestSequence: cursorSeq, eventTime: view.cursor.eventTime };
  }, [view, live, cursorSeq]);

  const loadView = useCallback(async (nextLive: boolean, seq: number) => {
    try {
      if (nextLive) {
        const fresh = await fetchView(null, true);
        setView(fresh);
      } else {
        const fresh = await fetchView({ ingestSequence: seq, eventTime: 0 }, false);
        setView(fresh);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    loadView(true, 0);
    const dispose = connectLiveSocket((event: LiveLedgerEvent) => {
      if (liveRef.current) {
        loadView(true, 0);
      } else {
        setView((prev) =>
          prev
            ? {
                ...prev,
                ledgerInfo: {
                  ...prev.ledgerInfo,
                  totalRecords: event.totalRecords,
                  maxIngestSequence: event.maxIngestSequence,
                  maxEventTime: event.maxEventTime
                }
              }
            : prev
        );
      }
    });
    const interval = window.setInterval(() => {
      if (liveRef.current) loadView(true, 0);
    }, 2500);
    return () => {
      dispose();
      window.clearInterval(interval);
    };
  }, [loadView]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    const cursor = effectiveCursor;
    fetchSpan(selected.traceId, selected.spanId, cursor, live)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, effectiveCursor, live]);

  const maxSeq = view?.ledgerInfo.maxIngestSequence ?? 0;
  const minSeq = view?.ledgerInfo.minIngestSequence ?? 0;
  const timelineValue = live ? maxSeq : cursorSeq;

  const visibleSpans = useMemo(() => {
    if (!view) return [];
    if (!selectedService) return view.spans;
    return view.spans.filter((s) => s.service === selectedService);
  }, [view, selectedService]);

  const handleToggleLive = () => {
    if (!live) {
      setLive(true);
      loadView(true, 0);
    } else {
      setLive(false);
      setCursorSeq(maxSeq);
      loadView(false, maxSeq);
    }
  };

  const handleTimeline = (value: number) => {
    setLive(false);
    setCursorSeq(value);
    loadView(false, value);
  };

  const handleSelectSpan = (traceId: string, spanId: string) => {
    setSelected({ traceId, spanId });
    const span = view?.spans.find((s) => s.traceId === traceId && s.spanId === spanId);
    if (span) setSelectedService(span.service);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>分布式链路事故回放平台</h1>
        <span className="badge">v{view?.contractVersion ?? 1}</span>
        {live ? <span className="badge live">● 实时跟随</span> : <span className="badge paused">❚❚ 已暂停回放</span>}
        <span className="badge">ledger {view?.ledgerInfo.totalRecords ?? 0} 条</span>
        <span className="badge">spans {view?.spans.length ?? 0}</span>
        <span className="badge">错误路径 {view?.errorPaths.length ?? 0}</span>
        {error ? <span className="badge" style={{ color: 'var(--error)' }}>{error}</span> : null}
        <div className="spacer" />
        <button
          className={live ? 'danger' : 'primary'}
          onClick={handleToggleLive}
          data-testid="toggle-live"
        >
          {live ? '暂停回放' : '回到实时'}
        </button>
      </header>

      <aside className="panel left">
        <div className="panel-title">trace & span 列表</div>
        <div className="panel-body">
          <div className="trace-tabs">
            <button
              className={`trace-tab ${selectedService === null ? 'active' : ''}`}
              onClick={() => setSelectedService(null)}
            >
              全部服务
            </button>
            {view?.topology.nodes.map((node) => (
              <button
                key={node.id}
                className={`trace-tab ${selectedService === node.service ? 'active' : ''}`}
                onClick={() => setSelectedService(node.service)}
                data-testid={`service-tab-${node.service}`}
              >
                {node.service}{node.errorCount > 0 ? ` !${node.errorCount}` : ''}
              </button>
            ))}
          </div>
          <SpanList
            spans={visibleSpans}
            selectedKey={selected ? `${selected.traceId}:${selected.spanId}` : null}
            onSelect={handleSelectSpan}
          />
        </div>
      </aside>

      {view ? (
        <TopologyScene
          view={view}
          selectedService={selectedService}
          selectedSpanKey={selected ? `${selected.traceId}:${selected.spanId}` : null}
          onSelectService={(svc) => setSelectedService(svc)}
        />
      ) : (
        <div className="panel center" style={{ gridArea: 'center' }}>
          <div className="empty">加载账本视图…</div>
        </div>
      )}

      <aside className="panel right">
        <div className="panel-title">span 详情 / 版本理由</div>
        <div className="panel-body">
          <SpanDetailPanel detail={detail} loading={detailLoading} />
        </div>
      </aside>

      <section className="panel timeline-panel">
        <div className="timeline-row">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>ingestSequence</span>
          <input
            type="range"
            min={minSeq}
            max={Math.max(maxSeq, minSeq)}
            value={Math.min(timelineValue, Math.max(maxSeq, minSeq))}
            onChange={(e) => handleTimeline(Number(e.target.value))}
            data-testid="timeline"
            disabled={maxSeq === 0}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>#{timelineValue}</span>
        </div>
        <div className="cursor-meta">
          <span>cursor.eventTime: <b>{formatClock(effectiveCursor?.eventTime ?? 0)}</b></span>
          <span>cursor.ingestSequence: <b>{effectiveCursor?.ingestSequence ?? 0}</b></span>
          <span>eventTime 范围: <b>{formatClock(view?.ledgerInfo.minEventTime ?? 0)} ~ {formatClock(view?.ledgerInfo.maxEventTime ?? 0)}</b></span>
          <span>视图生成: <b>{formatClock(view?.generatedAt ?? 0)}</b></span>
        </div>
      </section>
    </div>
  );
}
