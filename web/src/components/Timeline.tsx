import { useMemo, useRef } from "react";
import type { LedgerEntryV1 } from "@replay/shared";
import { formatTime } from "../api.js";
import type { Snapshot } from "../state.js";

export interface TimelineProps {
  snap: Snapshot;
  entries: readonly LedgerEntryV1[];
  lateBeyond: number;
  lateInPast: number;
  onScrub(eventTime: number): void;
  onSetIngest(seq: number): void;
  onToggleMode(): void;
  onAbsorb(): void;
}

const BIN_COUNT = 96;

export function Timeline(props: TimelineProps): React.JSX.Element {
  const { snap } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const bins = useMemo(() => {
    const { domainMin, domainMax } = snap;
    if (!domainMax || domainMax <= domainMin) return [];
    const span = domainMax - domainMin + 1;
    const counts = new Array<number>(BIN_COUNT).fill(0);
    const errors = new Array<number>(BIN_COUNT).fill(0);
    for (const e of props.entries) {
      const idx = Math.min(
        BIN_COUNT - 1,
        Math.floor(((e.event.eventTime - domainMin) / span) * BIN_COUNT),
      );
      if (idx < 0) continue;
      counts[idx] = (counts[idx] ?? 0) + 1;
      if (e.event.status === "error") errors[idx] = (errors[idx] ?? 0) + 1;
    }
    const max = Math.max(1, ...counts);
    return counts.map((c, i) => ({ count: c, errors: errors[i] ?? 0, ratio: c / max }));
  }, [props.entries, snap.domainMin, snap.domainMax]);

  const span = Math.max(1, snap.domainMax - snap.domainMin);
  const cursorPct = Math.min(
    100,
    Math.max(0, ((snap.cursor.eventTime - snap.domainMin) / span) * 100),
  );

  const timeFromClientX = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return snap.domainMin;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snap.domainMin + ratio * span;
  };

  return (
    <footer className="timeline" data-testid="timeline">
      <div className="timeline-row">
        <button
          type="button"
          className="btn primary"
          data-testid="mode-toggle"
          onClick={props.onToggleMode}
        >
          {snap.mode === "live" ? "暂停回放" : "跟随实时"}
        </button>
        <div
          ref={trackRef}
          className="timeline-track"
          data-testid="timeline-track"
          onPointerDown={(e) => {
            draggingRef.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            props.onScrub(timeFromClientX(e.clientX));
          }}
          onPointerMove={(e) => {
            if (draggingRef.current) props.onScrub(timeFromClientX(e.clientX));
          }}
          onPointerUp={(e) => {
            draggingRef.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        >
          <div className="timeline-bins">
            {bins.map((b, i) => (
              <div key={i} className="timeline-bin" style={{ height: `${Math.max(6, b.ratio * 100)}%` }}>
                {b.errors > 0 && (
                  <div
                    className="timeline-bin-errors"
                    style={{ height: `${Math.min(100, (b.errors / Math.max(1, b.count)) * 100)}%` }}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="timeline-thumb" style={{ left: `${cursorPct}%` }} />
        </div>
        <div className="timeline-labels">
          <span>{formatTime(snap.domainMin)}</span>
          <span data-testid="cursor-readout">
            T={formatTime(snap.cursor.eventTime)} · ingest={snap.cursor.ingestSequence}
          </span>
          <span>{formatTime(snap.domainMax)}</span>
        </div>
      </div>
      <div className="timeline-row ingest-row">
        <label htmlFor="ingest-slider">ingest 游标</label>
        <input
          id="ingest-slider"
          data-testid="ingest-slider"
          type="range"
          min={0}
          max={snap.head.ingestSequence}
          value={snap.cursor.ingestSequence}
          disabled={snap.mode === "live"}
          onChange={(e) => props.onSetIngest(Number(e.target.value))}
        />
        <span className="mono" data-testid="ingest-readout">
          {snap.cursor.ingestSequence} / {snap.head.ingestSequence}
        </span>
        {snap.mode === "paused" && props.lateBeyond > 0 && (
          <span className="late-banner" data-testid="late-banner">
            暂停期间新到达 {props.lateBeyond} 条，其中 {props.lateInPast} 条写入过去时点
            <button type="button" className="btn" data-testid="absorb-btn" onClick={props.onAbsorb}>
              吸收最新
            </button>
          </span>
        )}
      </div>
    </footer>
  );
}
