import { useMemo, useState } from 'react';
import type { SpanView } from '@shared/contracts.js';
import type { Selection } from './Topology3D.js';

interface SpanListProps {
  spans: SpanView[];
  selected: Selection | null;
  onSelect: (sel: Selection) => void;
}

type StatusFilter = 'all' | 'error' | 'ok';

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + '…' : id;
}

function formatTime(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function SpanList({ spans, selected, onSelect }: SpanListProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [service, setService] = useState('all');

  const services = useMemo(() => {
    const set = new Set<string>();
    spans.forEach((s) => set.add(s.service));
    return [...set].sort();
  }, [spans]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return spans.filter((s) => {
      if (status !== 'all' && s.status !== status) return false;
      if (service !== 'all' && s.service !== service) return false;
      if (q) {
        const hay = `${s.traceId} ${s.spanId} ${s.service} ${s.operation} ${s.errorMessage ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [spans, query, status, service]);

  return (
    <div className="panel list-panel">
      <div className="panel-header">
        <span>Spans ({filtered.length})</span>
      </div>
      <div className="filter-row">
        <input
          type="text"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="filter-spans"
        />
      </div>
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="filter-status">
          <option value="all">All status</option>
          <option value="error">Errors</option>
          <option value="ok">OK</option>
        </select>
        <select value={service} onChange={(e) => setService(e.target.value)} aria-label="filter-service">
          <option value="all">All services</option>
          {services.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="panel-body">
        {filtered.length === 0 ? (
          <div className="empty">No spans at this cursor.</div>
        ) : (
          <ul className="span-list">
            {filtered.map((s) => {
              const isSel = selected?.traceId === s.traceId && selected?.spanId === s.spanId;
              return (
                <li
                  key={`${s.traceId}:${s.spanId}`}
                  className={`span-item ${isSel ? 'selected' : ''}`}
                  onClick={() => onSelect({ traceId: s.traceId, spanId: s.spanId })}
                >
                  <div className="row1">
                    <span>
                      <span className={`status-dot ${s.status}`} />
                      <span className="svc">{s.service}</span>
                    </span>
                    <span className="op">{s.operation}</span>
                  </div>
                  <div className="meta">
                    rev {s.revision} · {shortId(s.spanId)} · {formatTime(s.eventTime)}
                    {s.arrivalDelayMs > 1000 ? ` · late ${s.arrivalDelayMs}ms` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
