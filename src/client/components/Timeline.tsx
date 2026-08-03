import { useMemo } from 'react';
import type { ReplayCursor, ReplayView } from '@shared/contracts.js';

interface TimelineProps {
  view: ReplayView;
  cursor: ReplayCursor;
  head: ReplayCursor;
  isLive: boolean;
  onCursorChange: (cursor: ReplayCursor) => void;
}

function formatTime(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatOffset(baseMs: number, ms: number): string {
  if (baseMs <= 0) return '0ms';
  const delta = ms - baseMs;
  return `${delta >= 0 ? '+' : ''}${delta}ms`;
}

export function Timeline({ view, cursor, head, onCursorChange }: TimelineProps) {
  const { minEvent, maxEvent } = useMemo(() => {
    if (view.spans.length === 0) return { minEvent: 0, maxEvent: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (const s of view.spans) {
      if (s.eventTime < min) min = s.eventTime;
      if (s.eventTime > max) max = s.eventTime;
    }
    return { minEvent: min, maxEvent: max };
  }, [view.spans]);

  const headMaxEvent = head.eventTime || maxEvent;
  const eventMin = minEvent;
  const eventMax = headMaxEvent || 1;
  const eventRange = eventMax - eventMin || 1;
  const seqMax = head.ingestSequence || 1;

  const markers = useMemo(() => {
    return view.spans.map((s) => {
      const left = ((s.eventTime - eventMin) / eventRange) * 100;
      const isLate = s.arrivalDelayMs > 1000;
      const cls = s.status === 'error' ? 'error' : isLate ? 'late' : 'span';
      return { left: Math.max(0, Math.min(100, left)), cls, key: `${s.traceId}:${s.spanId}` };
    });
  }, [view.spans, eventMin, eventRange]);

  const playheadLeft = headMaxEvent > 0
    ? ((cursor.eventTime - eventMin) / eventRange) * 100
    : 0;

  return (
    <div className="timeline-panel">
      <div className="timeline-row">
        <label>Event time</label>
        <input
          type="range"
          min={eventMin}
          max={eventMax}
          step={1}
          value={Math.min(Math.max(cursor.eventTime, eventMin), eventMax)}
          onChange={(e) =>
            onCursorChange({ ...cursor, eventTime: Number(e.target.value) })
          }
          aria-label="event-time"
        />
        <span className="val">
          {formatTime(cursor.eventTime)} <span style={{ color: 'var(--text-dim)' }}>({formatOffset(eventMin, cursor.eventTime)})</span>
        </span>
      </div>
      <div className="timeline-track">
        {markers.map((m) => (
          <div
            key={m.key}
            className={`timeline-marker ${m.cls}`}
            style={{ left: `${m.left}%` }}
          />
        ))}
        <div className="timeline-playhead" style={{ left: `${Math.max(0, Math.min(100, playheadLeft))}%` }} />
      </div>
      <div className="timeline-row" style={{ marginTop: 8 }}>
        <label>Ingest horizon</label>
        <input
          type="range"
          min={0}
          max={seqMax}
          step={1}
          value={Math.min(cursor.ingestSequence, seqMax)}
          onChange={(e) =>
            onCursorChange({ ...cursor, ingestSequence: Number(e.target.value) })
          }
          aria-label="ingest-sequence"
        />
        <span className="val">
          seq {cursor.ingestSequence} / {head.ingestSequence}
        </span>
      </div>
    </div>
  );
}
