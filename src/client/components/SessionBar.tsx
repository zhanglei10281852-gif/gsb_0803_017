import { useState, type FormEvent } from 'react';
import type { UseSession } from '../hooks/useSession.js';

interface SessionBarProps {
  session: UseSession;
}

function formatTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function SessionBar({ session }: SessionBarProps): JSX.Element {
  const {
    lease,
    isLeader,
    followState,
    notes,
    clientId,
    clientName,
    leaderName,
    fencingToken,
    setClientName,
    acquire,
    release,
    setFollowing,
    addNote,
  } = session;

  const [noteText, setNoteText] = useState('');
  const [showNotes, setShowNotes] = useState(false);

  const handleSubmitNote = (e: FormEvent) => {
    e.preventDefault();
    const text = noteText.trim();
    if (!text) return;
    addNote(text, null);
    setNoteText('');
  };

  const stateLabel = followState === 'lost-lease'
    ? '⚠ Lease lost — another operator took over'
    : isLeader
      ? '👑 You are leading (seal & advance cursor)'
      : lease
        ? `👁 Following ${leaderName}`
        : '🔍 No active leader — independent view';

  const stateClass = followState === 'lost-lease'
    ? 'session-state lost'
    : isLeader
      ? 'session-state leader'
      : lease
        ? 'session-state following'
        : 'session-state none';

  return (
    <div className="session-bar">
      <div className="session-left">
        <span className={stateClass}>{stateLabel}</span>
        {fencingToken !== null && (
          <span className="fencing-badge" title="Monotonic fencing token — stale holders cannot mutate">
            fencing #{fencingToken}
          </span>
        )}
        {lease && (
          <span className="lease-expiry">
            expires {formatTime(lease.expiresAt)}
          </span>
        )}
      </div>

      <div className="session-center">
        <input
          className="client-name-input"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          placeholder="your name"
          aria-label="client-name"
        />
        {isLeader ? (
          <button className="danger" onClick={release}>⏏ Release lease</button>
        ) : (
          <button onClick={() => void acquire()} disabled={followState === 'lost-lease' ? false : !!lease}>
            {lease ? '⇄ Take over lease' : '🔔 Take lead'}
          </button>
        )}
        <button
          className={followState === 'independent' ? '' : 'active'}
          onClick={() => setFollowing(true)}
          disabled={!lease && !isLeader}
        >
          ▶ Follow
        </button>
        <button
          className={followState === 'independent' ? 'active' : ''}
          onClick={() => setFollowing(false)}
        >
          ✂ Independent
        </button>
      </div>

      <div className="session-right">
        <form className="note-form" onSubmit={handleSubmitNote}>
          <input
            className="note-input"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Shared investigation note…"
            aria-label="note-input"
          />
          <button type="submit" disabled={!noteText.trim()}>＋ Add</button>
        </form>
        <button className="notes-toggle" onClick={() => setShowNotes((v) => !v)}>
          💬 {notes.length}
        </button>
      </div>

      {showNotes && (
        <div className="notes-popover">
          <div className="notes-header">
            <strong>Shared notes ({notes.length})</strong>
            <span className="notes-hint">merge by (clientId, seq) — deterministic, no last-writer-wins</span>
          </div>
          <ul className="notes-list">
            {notes.length === 0 && <li className="notes-empty">No notes yet.</li>}
            {notes.map((n) => (
              <li key={`${n.clientId}:${n.clientSeq}`} className={n.clientId === clientId ? 'mine' : ''}>
                <div className="note-meta">
                  <strong>{n.authorName}</strong>
                  <span className="note-time">{formatTime(n.createdAt)}</span>
                  {n.clientId === clientId && <span className="note-you">you</span>}
                </div>
                <div className="note-text">{n.text}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
