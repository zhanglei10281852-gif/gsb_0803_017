import { useEffect, useState } from 'react';
import {
  createSnapshot,
  listSnapshots,
  updateSnapshotNotes
} from '../api/client';
import { IncidentSnapshot, ReplayCursor, SpanDiffEntry } from '../../shared/contracts';

interface SnapshotPanelProps {
  currentCursor: ReplayCursor | null;
  live: boolean;
}

function shortHash(value: string): string {
  return value.slice(0, 10);
}

function formatTime(ms: number): string {
  if (ms <= 0) return '—';
  return new Date(ms).toISOString().slice(11, 19);
}

function diffRowClass(entry: SpanDiffEntry): string {
  if (entry.kind === 'added') return 'diff-add';
  if (entry.kind === 'removed') return 'diff-remove';
  if (entry.kind === 'status-changed') return 'diff-status';
  return 'diff-revision';
}

export function SnapshotPanel({ currentCursor, live }: SnapshotPanelProps) {
  const [snapshots, setSnapshots] = useState<IncidentSnapshot[]>([]);
  const [selected, setSelected] = useState<IncidentSnapshot | null>(null);
  const [notes, setNotes] = useState('');
  const [labelA, setLabelA] = useState('故障初判');
  const [labelB, setLabelB] = useState('错误确认');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    listSnapshots()
      .then((items) => {
        setSnapshots(items);
        if (selected) {
          const fresh = items.find((s) => s.id === selected.id) ?? null;
          setSelected(fresh);
          if (fresh) setNotes(fresh.notes);
        }
      })
      .catch((err: Error) => setMessage(err.message));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleCapture = async (side: 'A' | 'B') => {
    if (!currentCursor) return;
    setMessage(null);
    const existing = selected;
    const cursorA = side === 'A' ? currentCursor : existing?.cursorA ?? currentCursor;
    const cursorB = side === 'B' ? currentCursor : existing?.cursorB ?? currentCursor;
    const snapshot = await createSnapshot({
      labelA: side === 'A' ? labelA : existing?.labelA ?? labelA,
      labelB: side === 'B' ? labelB : existing?.labelB ?? labelB,
      cursorA,
      cursorB,
      notes
    });
    setSelected(snapshot);
    setNotes(snapshot.notes);
    refresh();
  };

  const handleCompareCurrent = async () => {
    if (!currentCursor) return;
    setMessage(null);
    if (!selected) {
      setMessage('请先封存一个游标作为 A，再封存 B 进行对比');
      return;
    }
    const snapshot = await createSnapshot({
      labelA: selected.labelA,
      labelB,
      cursorA: selected.cursorA,
      cursorB: currentCursor,
      notes
    });
    setSelected(snapshot);
    setNotes(snapshot.notes);
    refresh();
  };

  const handleSaveNotes = async () => {
    if (!selected) return;
    const updated = await updateSnapshotNotes(selected.id, notes);
    setSelected(updated);
    setMessage('备注已保存（封存结果不变）');
    refresh();
  };

  const s = selected;

  return (
    <div className="snapshot-panel">
      <div className="snap-toolbar">
        <input
          value={labelA}
          onChange={(e) => setLabelA(e.target.value)}
          placeholder="A 标签"
          aria-label="label A"
        />
        <input
          value={labelB}
          onChange={(e) => setLabelB(e.target.value)}
          placeholder="B 标签"
          aria-label="label B"
        />
        <button onClick={() => handleCapture('A')} disabled={!currentCursor} data-testid="capture-a">
          封存 A{!live ? ` (#${currentCursor?.ingestSequence})` : ' (live)'}
        </button>
        <button onClick={() => handleCapture('B')} disabled={!currentCursor} data-testid="capture-b">
          封存 B{!live ? ` (#${currentCursor?.ingestSequence})` : ' (live)'}
        </button>
        {s ? (
          <button className="primary" onClick={handleCompareCurrent} data-testid="compare-now">
            用当前游标作 B
          </button>
        ) : null}
      </div>

      {s ? (
        <div className="snap-detail" data-testid="snapshot-detail">
          <div className="snap-head">
            <div>
              <strong>{s.labelA}</strong>
              <span className="muted"> seq {s.cursorA.ingestSequence} · {formatTime(s.cursorA.eventTime)}</span>
            </div>
            <div className="arrow">→</div>
            <div>
              <strong>{s.labelB}</strong>
              <span className="muted"> seq {s.cursorB.ingestSequence} · {formatTime(s.cursorB.eventTime)}</span>
            </div>
          </div>
          <div className="snap-digests">
            <div>
              <span className="muted">A recordsDigest</span>{' '}
              <code data-testid="digest-a">{shortHash(s.digestA.recordsDigest)}</code>
              <span className="muted"> fp </span>
              <code>{shortHash(s.digestA.viewFingerprint)}</code>
            </div>
            <div>
              <span className="muted">B recordsDigest</span>{' '}
              <code data-testid="digest-b">{shortHash(s.digestB.recordsDigest)}</code>
              <span className="muted"> fp </span>
              <code>{shortHash(s.digestB.viewFingerprint)}</code>
            </div>
            <div className="muted">
              高水位 seq {s.digestB.ledgerHighWatermark.maxIngestSequence} · 账本 {s.digestB.ledgerHighWatermark.totalRecords} 条 · 封存于 {formatTime(s.createdAt)}
            </div>
          </div>

          <div className="diff-summary">
            <span className="chip add">新增 {s.diff.summary.addedCount}</span>
            <span className="chip remove">消失 {s.diff.summary.removedCount}</span>
            <span className="chip status">状态变化 {s.diff.summary.statusChangedCount}</span>
            <span className="chip revision">修订变化 {s.diff.summary.revisionChangedCount}</span>
            <span className="chip path">关键路径 {s.diff.summary.criticalPathChangeCount}</span>
          </div>

          <div className="diff-columns">
            <DiffColumn title="新增" entries={s.diff.added} />
            <DiffColumn title="消失" entries={s.diff.removed} />
            <DiffColumn title="状态变化" entries={s.diff.statusChanged} />
            <DiffColumn title="修订变化" entries={s.diff.revisionChanged} />
          </div>

          {s.diff.criticalPathChanges.length > 0 ? (
            <div className="path-changes">
              <div className="section-label">关键路径变化</div>
              {s.diff.criticalPathChanges.map((change, idx) => (
                <div key={`${change.key}-${idx}`} className="path-change" data-testid={`path-change-${idx}`}>
                  <span className="chip path">{change.change}</span>
                  <span>{change.traceId}: {change.originSpanId}</span>
                  <div className="muted">
                    {change.beforePath.join(' → ') || '∅'} ⇒ {change.afterPath.join(' → ') || '∅'}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="notes-area">
            <div className="section-label">调查备注（仅备注可改，封存结果不可变）</div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              data-testid="snapshot-notes"
            />
            <button className="primary" onClick={handleSaveNotes} data-testid="save-notes">
              保存备注
            </button>
          </div>
        </div>
      ) : (
        <div className="empty">拖动时间线到关键时刻，点击"封存 A"；再移动到另一时刻"封存 B"进行对比。</div>
      )}

      {message ? <div className="snap-message">{message}</div> : null}

      {snapshots.length > 0 ? (
        <div className="snap-history">
          <div className="section-label">已封存快照（append-only）</div>
          {snapshots.map((item) => (
            <button
              key={item.id}
              className={`snap-history-item ${selected?.id === item.id ? 'active' : ''}`}
              onClick={() => {
                setSelected(item);
                setNotes(item.notes);
              }}
              data-testid={`snap-history-${item.id.slice(0, 8)}`}
            >
              <span>{item.labelA} → {item.labelB}</span>
              <span className="muted">
                +{item.diff.summary.addedCount}/-{item.diff.summary.removedCount}/s{item.diff.summary.statusChangedCount} · {shortHash(item.digestA.recordsDigest)}→{shortHash(item.digestB.recordsDigest)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiffColumn({ title, entries }: { title: string; entries: readonly SpanDiffEntry[] }) {
  return (
    <div className="diff-column">
      <div className="section-label">{title} ({entries.length})</div>
      {entries.length === 0 ? <div className="muted small">无</div> : null}
      {entries.map((entry) => (
        <div key={`${entry.traceId}:${entry.spanId}:${entry.kind}`} className={`diff-entry ${diffRowClass(entry)}`}>
          <div><strong>{entry.service}</strong> / {entry.operation}</div>
          <div className="muted small">{entry.detail}</div>
          <div className="muted small">{entry.spanId}</div>
        </div>
      ))}
    </div>
  );
}
