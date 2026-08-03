import { useCallback, useEffect, useState } from 'react';
import type {
  IncidentSnapshot,
  ReplayCursor,
  SnapshotDiff,
  SpanView,
} from '@shared/contracts.js';
import {
  compareSnapshots,
  createSnapshot,
  listSnapshots,
  updateSnapshotNotes,
} from '../api.js';

interface SnapshotPanelProps {
  cursor: ReplayCursor;
  onJumpTo: (cursor: ReplayCursor) => void;
  fencing: { clientId: string; token: number } | null;
  leaderName: string;
  isLeader: boolean;
  leaseActive: boolean;
}

function formatTime(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function shortDigest(d: string): string {
  return d.slice(0, 12) + '…';
}

function SpanRef({ span, kind }: { span: SpanView; kind: 'add' | 'remove' | 'change' }): JSX.Element {
  const color = kind === 'add' ? 'var(--ok)' : kind === 'remove' ? 'var(--error)' : 'var(--warn)';
  const arrow = kind === 'add' ? '+' : kind === 'remove' ? '−' : '~';
  return (
    <div className="diff-span" style={{ borderLeftColor: color }}>
      <span className="diff-arrow" style={{ color }}>{arrow}</span>
      <span className={`status-dot ${span.status}`} />
      <span className="diff-svc">{span.service}</span>
      <span className="diff-op">{span.operation}</span>
      <span className="diff-meta">
        rev {span.revision} · {span.spanId.slice(0, 10)}…
      </span>
    </div>
  );
}

export function SnapshotPanel({ cursor, onJumpTo, fencing, leaderName, isLeader, leaseActive }: SnapshotPanelProps): JSX.Element {
  const [snapA, setSnapA] = useState<IncidentSnapshot | null>(null);
  const [snapB, setSnapB] = useState<IncidentSnapshot | null>(null);
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [notesA, setNotesA] = useState('');
  const [notesB, setNotesB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshAll = useCallback(async () => {
    try {
      const { snapshots } = await listSnapshots();
      const latestA = [...snapshots].reverse().find((s) => s.slot === 'A') ?? null;
      const latestB = [...snapshots].reverse().find((s) => s.slot === 'B') ?? null;
      setSnapA(latestA);
      setSnapB(latestB);
      if (latestA) setNotesA(latestA.notes);
      if (latestB) setNotesB(latestB.notes);
      if (latestA && latestB) {
        const d = await compareSnapshots(latestA.id, latestB.id);
        setDiff(d);
      } else {
        setDiff(null);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const handleCapture = useCallback(async (slot: 'A' | 'B') => {
    setBusy(true);
    try {
      const label = slot === 'A' ? `Moment A @ seq ${cursor.ingestSequence}` : `Moment B @ seq ${cursor.ingestSequence}`;
      await createSnapshot(slot, cursor, label, '', fencing);
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [cursor, refreshAll, fencing]);

  const canSeal = !leaseActive || isLeader;
  const sealHint = leaseActive && !isLeader
    ? `Only ${leaderName} (lease holder) can seal snapshots. Take over the lease to seal.`
    : null;

  const handleSaveNotes = useCallback(async (slot: 'A' | 'B') => {
    const snap = slot === 'A' ? snapA : snapB;
    const notes = slot === 'A' ? notesA : notesB;
    if (!snap) return;
    setBusy(true);
    try {
      const updated = await updateSnapshotNotes(snap.id, notes);
      if (slot === 'A') setSnapA(updated);
      else setSnapB(updated);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [snapA, snapB, notesA, notesB]);

  const handleJump = useCallback((snap: IncidentSnapshot) => {
    onJumpTo(snap.cursor);
  }, [onJumpTo]);

  return (
    <div className="snapshot-panel">
      <div className="snapshot-header">
        <span className="snapshot-title">📸 Incident comparison — seal two replay cursors</span>
        <div className="snapshot-actions">
          <button onClick={() => void handleCapture('A')} disabled={busy || !canSeal} className="snap-a">
            Seal A here
          </button>
          <button onClick={() => void handleCapture('B')} disabled={busy || !canSeal} className="snap-b">
            Seal B here
          </button>
          <button onClick={() => void refreshAll()} disabled={busy}>↻ Refresh</button>
        </div>
      </div>

      {sealHint && <div className="snapshot-hint" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}>{sealHint}</div>}
      {error && <div className="snapshot-error">{error}</div>}

      <div className="snapshot-cards">
        <SnapshotCard
          slot="A"
          snap={snapA}
          notes={notesA}
          onNotesChange={setNotesA}
          onSaveNotes={() => void handleSaveNotes('A')}
          onJump={() => snapA && handleJump(snapA)}
          busy={busy}
        />
        <SnapshotCard
          slot="B"
          snap={snapB}
          notes={notesB}
          onNotesChange={setNotesB}
          onSaveNotes={() => void handleSaveNotes('B')}
          onJump={() => snapB && handleJump(snapB)}
          busy={busy}
        />
      </div>

      {diff && (
        <div className="snapshot-diff">
          <div className="diff-summary">
            <span className="diff-pill add">+{diff.summary.addedCount} added</span>
            <span className="diff-pill remove">−{diff.summary.removedCount} disappeared</span>
            <span className="diff-pill change">~{diff.summary.changedCount} changed</span>
            <span className="diff-pill path">⚠ {diff.summary.criticalPathChangeCount} critical path</span>
            {diff.sameDigest && <span className="diff-pill same">identical digest</span>}
          </div>

          {diff.added.length > 0 && (
            <div className="diff-section">
              <h4>Newly visible at B</h4>
              {diff.added.map((s) => (
                <SpanRef key={`${s.traceId}:${s.spanId}`} span={s} kind="add" />
              ))}
            </div>
          )}

          {diff.removed.length > 0 && (
            <div className="diff-section">
              <h4>Disappeared at B</h4>
              {diff.removed.map((s) => (
                <SpanRef key={`${s.traceId}:${s.spanId}`} span={s} kind="remove" />
              ))}
            </div>
          )}

          {diff.changed.length > 0 && (
            <div className="diff-section">
              <h4>Status / revision changes</h4>
              {diff.changed.map((c) => (
                <div key={`${c.traceId}:${c.spanId}`} className="diff-change">
                  <SpanRef span={c.after} kind="change" />
                  <div className="diff-fields">
                    {c.fields.map((f) => (
                      <span key={f} className="field-tag">
                        {f}:{' '}
                        <span className="field-before">{String(c.before[f as keyof SpanView] ?? '—')}</span>
                        {' → '}
                        <span className="field-after">{String(c.after[f as keyof SpanView] ?? '—')}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {diff.criticalPathChanges.length > 0 && (
            <div className="diff-section">
              <h4>Critical path changes</h4>
              {diff.criticalPathChanges.map((cp, i) => (
                <div key={i} className="diff-path">
                  <div className="path-trace">{cp.traceId} / {cp.rootErrorSpanId}</div>
                  <div className="path-line">
                    <span className="path-label">A:</span> {cp.beforePath.join(' → ')}
                  </div>
                  <div className="path-line">
                    <span className="path-label">B:</span> {cp.afterPath.join(' → ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!snapA || !snapB ? (
        <div className="snapshot-hint">
          Seal both moments A and B (set the replay cursor to each key moment first) to compare added, disappeared, status and critical-path changes.
        </div>
      ) : null}
    </div>
  );
}

interface SnapshotCardProps {
  slot: 'A' | 'B';
  snap: IncidentSnapshot | null;
  notes: string;
  onNotesChange: (v: string) => void;
  onSaveNotes: () => void;
  onJump: () => void;
  busy: boolean;
}

function SnapshotCard({ slot, snap, notes, onNotesChange, onSaveNotes, onJump, busy }: SnapshotCardProps): JSX.Element {
  const cls = slot === 'A' ? 'snap-card-a' : 'snap-card-b';
  return (
    <div className={`snap-card ${cls}`}>
      <div className="snap-card-head">
        <strong>Moment {slot}</strong>
        {snap && (
          <button className="link-btn" onClick={onJump}>⏎ jump to cursor</button>
        )}
      </div>
      {snap ? (
        <>
          <div className="snap-kv">
            <span className="k">label</span><span className="v">{snap.label}</span>
            <span className="k">cursor</span>
            <span className="v">t={snap.cursor.eventTime} · seq={snap.cursor.ingestSequence}</span>
            <span className="k">ledger head</span>
            <span className="v">t={snap.ledgerHead.eventTime} · seq={snap.ledgerHead.ingestSequence}</span>
            <span className="k">records</span>
            <span className="v">{snap.visibleRecordCount} visible / {snap.totalLedgerRecords} total</span>
            <span className="k">digest</span><span className="v mono">{shortDigest(snap.digest)}</span>
            <span className="k">sealed</span><span className="v">{formatTime(snap.createdAt)}</span>
          </div>
          <textarea
            className="snap-notes"
            placeholder="Investigation notes (why was this moment chosen?)…"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            aria-label={`notes-${slot}`}
          />
          <button className="save-notes" onClick={onSaveNotes} disabled={busy}>Save notes</button>
        </>
      ) : (
        <div className="snap-empty">Not sealed yet. Position the replay cursor and click “Seal {slot} here”.</div>
      )}
    </div>
  );
}
