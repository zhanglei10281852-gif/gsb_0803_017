import { useCallback, useEffect, useState } from 'react';
import type {
  IncidentSnapshot,
  ReplayCursor,
  SnapshotComparison,
  SpanDelta,
} from '../shared/contract';
import { compareSnapshots, listSnapshots, sealSnapshot } from './api';

interface Props {
  /** The cursor currently shown in the main replay view. */
  cursor: ReplayCursor;
  baseEventTimeMs: number;
  /** When set, seals are gated by the session lease + fencing token. */
  writer?: { sessionId: number; holder: string; fencingToken: number } | null;
  /** Non-null when sealing is blocked (in a session but not the owner). */
  sealBlockedReason?: string | null;
  /** Notify the parent when a new snapshot is sealed (to refresh anchors). */
  onSealed?: () => void;
}

/**
 * Snapshot & comparison workspace. Seals the *current* replay cursor (the same
 * ReplayCursor the 3D view uses) into an immutable IncidentSnapshot, then diffs
 * two sealed snapshots A -> B. No bypass model: everything is derived from the
 * shared ledger + projection via the server API.
 *
 * Under a shared session, sealing carries the writer credential so the server
 * fences out anyone who is not the current lease holder.
 */
export function SnapshotPanel({ cursor, baseEventTimeMs, writer, sealBlockedReason, onSealed }: Props): JSX.Element {
  const [snapshots, setSnapshots] = useState<IncidentSnapshot[]>([]);
  const [note, setNote] = useState('');
  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  const [comparison, setComparison] = useState<SnapshotComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSnapshots();
      setSnapshots(list);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  // Load any already-sealed snapshots on mount so they survive a page reload
  // and a server restart (the artifacts live in the same SQLite store).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSeal = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const nextLabel = String.fromCharCode(65 + (snapshots.length % 26)); // A, B, C...
      const sealed = await sealSnapshot({
        label: nextLabel,
        note: note.trim() === '' ? null : note.trim(),
        cursor,
        ...(writer ? { writer } : {}),
      });
      setNote('');
      const list = await listSnapshots();
      setSnapshots(list);
      onSealed?.();
      // Auto-select the two most recent snapshots as A/B for convenience.
      if (fromId === null) setFromId(sealed.snapshot.id);
      else setToId(sealed.snapshot.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [cursor, note, snapshots.length, fromId, writer, onSealed]);

  const onCompare = useCallback(async () => {
    if (fromId === null || toId === null) return;
    setBusy(true);
    setErr(null);
    try {
      const cmp = await compareSnapshots(fromId, toId);
      setComparison(cmp);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [fromId, toId]);

  return (
    <div className="snapshot-panel" data-testid="snapshot-panel">
      <div className="snap-header">
        <h3>事故快照对比</h3>
        <button type="button" className="btn small" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      <div className="snap-seal">
        <textarea
          className="snap-note"
          placeholder="调查备注（可选，将随快照一起封存）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="snapshot-note"
          rows={2}
        />
        <button
          type="button"
          className="btn live"
          onClick={() => void onSeal()}
          disabled={busy || sealBlockedReason != null}
          data-testid="seal-snapshot"
        >
          封存当前游标为快照
        </button>
        {sealBlockedReason != null && (
          <p className="snap-blocked" data-testid="seal-blocked">🔒 {sealBlockedReason}</p>
        )}
        <p className="snap-hint">
          将封存 事件时间 +{Math.max(0, cursor.eventTimeMs - baseEventTimeMs)}ms · 采集 #
          {cursor.ingestSequence}
        </p>
      </div>

      {err && <div className="error-banner" data-testid="snapshot-error">{err}</div>}

      <div className="snap-list" data-testid="snapshot-list">
        {snapshots.length === 0 ? (
          <p className="empty">尚无快照。拖动时间线到关键时刻后点击“封存”。</p>
        ) : (
          <ul>
            {snapshots.map((s) => (
              <li key={s.id} data-testid={`snapshot-${s.id}`}>
                <span className="snap-label">{s.label}</span>
                <span className="snap-meta">
                  #{s.id} · 采集≤{s.provenance.ledgerHighWater} · +
                  {Math.max(0, s.cursor.eventTimeMs - baseEventTimeMs)}ms
                </span>
                <span className="snap-digest" title={s.provenance.digest}>
                  {s.provenance.digest.slice(0, 10)}…
                </span>
                <span className="snap-pick">
                  <button
                    type="button"
                    className={fromId === s.id ? 'chip active' : 'chip'}
                    onClick={() => setFromId(s.id)}
                    data-testid={`pick-from-${s.id}`}
                  >
                    A
                  </button>
                  <button
                    type="button"
                    className={toId === s.id ? 'chip active' : 'chip'}
                    onClick={() => setToId(s.id)}
                    data-testid={`pick-to-${s.id}`}
                  >
                    B
                  </button>
                </span>
                {s.note && <span className="snap-note-inline">📝 {s.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        className="btn"
        onClick={() => void onCompare()}
        disabled={fromId === null || toId === null || fromId === toId || busy}
        data-testid="compare-button"
      >
        比较 A → B
      </button>

      {comparison && <ComparisonResult cmp={comparison} />}
    </div>
  );
}

function ComparisonResult({ cmp }: { cmp: SnapshotComparison }): JSX.Element {
  return (
    <div className="snap-diff" data-testid="comparison-result">
      <div className="diff-summary" data-testid="diff-summary">
        <span className="added">新增 {cmp.summary.added}</span>
        <span className="removed">消失 {cmp.summary.removed}</span>
        <span className="status">状态变化 {cmp.summary.statusChanged}</span>
        <span className="path">关键路径变化 {cmp.summary.pathChanged}</span>
        <span className="rev">修订变化 {cmp.summary.revisionChanged}</span>
      </div>
      <div className="diff-provenance">
        A #{cmp.from.id} ({cmp.from.provenance.digest.slice(0, 8)}) → B #{cmp.to.id} (
        {cmp.to.provenance.digest.slice(0, 8)})
        {' · '}高水位 {cmp.from.provenance.ledgerHighWater} → {cmp.to.provenance.ledgerHighWater}
      </div>

      <DeltaSection title="新增的 span" kind="added" items={cmp.added} />
      <DeltaSection title="消失的 span" kind="removed" items={cmp.removed} />
      <DeltaSection title="发生变化的 span" kind="changed" items={cmp.changed} />
    </div>
  );
}

function DeltaSection({
  title,
  kind,
  items,
}: {
  title: string;
  kind: 'added' | 'removed' | 'changed';
  items: SpanDelta[];
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className={`delta-section ${kind}`} data-testid={`delta-${kind}`}>
      <h4>{title}（{items.length}）</h4>
      <ul>
        {items.map((d) => (
          <li key={`${d.traceId}:${d.spanId}`} data-testid={`delta-item-${d.spanId}`}>
            <span className="d-svc">{d.service}</span>
            <span className="d-op">{d.operation}</span>
            <span className="d-tags">
              {d.statusChanged && (
                <em className="tag status">
                  {d.before?.status ?? '—'}→{d.after?.status ?? '—'}
                </em>
              )}
              {d.revisionChanged && (
                <em className="tag rev">
                  r{d.before?.revision ?? '—'}→r{d.after?.revision ?? '—'}
                </em>
              )}
              {d.pathChanged && (
                <em className="tag path">
                  {d.after?.onErrorPath ? '进入关键路径' : '离开关键路径'}
                </em>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
