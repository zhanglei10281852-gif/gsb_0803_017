import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acquireLease,
  addSessionNote,
  advanceCursor,
  connectSessionSocket,
  createSession,
  fetchSession,
  sealSessionSnapshot
} from '../api/client';
import { useParticipant } from '../hooks/useParticipant';
import {
  IncidentSnapshot,
  InvestigationSession,
  ReplayCursor,
  SessionClientState,
  SessionEvent,
  SessionNoteEntry,
  SessionRole
} from '../../shared/contracts';

interface CollaborationPanelProps {
  anchorSnapshot: IncidentSnapshot | null;
  currentCursor: ReplayCursor | null;
  live: boolean;
  onFollowCursor: (cursor: ReplayCursor) => void;
}

const LEASE_HEARTBEAT_MS = 8000;

type LeaseState =
  | { kind: 'idle' }
  | { kind: 'leader'; token: number; expiresAt: number }
  | { kind: 'follower'; leaderId: string; leaderName: string }
  | { kind: 'lost'; reason: string };

function roleFromLease(lease: InvestigationSession['lease'], participantId: string): SessionRole {
  if (!lease) return 'observer';
  return lease.leaderId === participantId ? 'leader' : 'follower';
}

export function CollaborationPanel(props: CollaborationPanelProps) {
  const { anchorSnapshot, currentCursor, onFollowCursor, live } = props;
  const { participant, setName } = useParticipant();
  const [nameDraft, setNameDraft] = useState(participant.name);
  const [session, setSession] = useState<InvestigationSession | null>(null);
  const [leaseState, setLeaseState] = useState<LeaseState>({ kind: 'idle' });
  const [clientState, setClientState] = useState<SessionClientState>('independent');
  const [noteDraft, setNoteDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [sealedLabel, setSealedLabel] = useState('');
  const heartbeatRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    setNameDraft(participant.name);
  }, [participant.name]);

  const applySession = useCallback(
    (next: InvestigationSession) => {
      setSession(next);
      const role = roleFromLease(next.lease, participant.id);
      setLeaseState((prev) => {
        if (next.lease && next.lease.leaderId === participant.id) {
          if (prev.kind === 'leader' && prev.token === next.lease.token) {
            return { kind: 'leader', token: next.lease.token, expiresAt: next.lease.expiresAt };
          }
          if (prev.kind !== 'leader') {
            setMessage('你已成为负责人，可以封存快照或推进共同游标');
          }
          return { kind: 'leader', token: next.lease.token, expiresAt: next.lease.expiresAt };
        }
        if (!next.lease) {
          if (prev.kind === 'leader' || prev.kind === 'lost') {
            setClientState('independent');
          }
          return { kind: 'idle' };
        }
        if (prev.kind === 'leader' && next.lease.leaderId !== participant.id) {
          setClientState('lease-lost');
          setMessage('租约已被新负责人接管，你进入只读跟随');
          return {
            kind: 'lost',
            reason: `负责人已变更为 ${next.lease.leaderName}`
          };
        }
        return {
          kind: 'follower',
          leaderId: next.lease.leaderId,
          leaderName: next.lease.leaderName
        };
      });
      void role;
    },
    [participant.id]
  );

  const startSession = useCallback(async () => {
    if (!anchorSnapshot) return;
    setMessage(null);
    try {
      const created = await createSession({
        anchorSnapshotId: anchorSnapshot.id,
        participantId: participant.id,
        participantName: participant.name
      });
      sessionIdRef.current = created.id;
      applySession(created);
      setClientState('following');
      setMessage('共享会话已创建，你是初始负责人');
    } catch (err) {
      setMessage((err as Error).message);
    }
  }, [anchorSnapshot, participant.id, participant.name, applySession]);

  const joinSession = useCallback(
    (id: string) => {
      sessionIdRef.current = id;
      fetchSession(id)
        .then((s) => applySession(s))
        .catch((err: Error) => setMessage(err.message));
    },
    [applySession]
  );

  useEffect(() => {
    if (anchorSnapshot && !session) {
      joinSession(anchorSnapshot.id);
    }
  }, [anchorSnapshot, session, joinSession]);

  useEffect(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    const dispose = connectSessionSocket(id, (event: SessionEvent) => {
      if (event.type === 'session-state' || event.type === 'lease-changed') {
        fetchSession(id).then(applySession).catch(() => undefined);
      } else if (event.type === 'cursor-advanced') {
        fetchSession(id).then(applySession).catch(() => undefined);
        if (clientState === 'following') {
          onFollowCursor(event.sharedCursor.cursor);
        }
      } else if (event.type === 'note-added') {
        setSession((prev) => {
          if (!prev) return prev;
          if (prev.notes.some((n) => n.id === event.note.id)) return prev;
          return { ...prev, notes: [...prev.notes, event.note] };
        });
      } else if (event.type === 'snapshot-sealed') {
        fetchSession(id).then(applySession).catch(() => undefined);
      }
    });
    return dispose;
  }, [session?.id, applySession, onFollowCursor, clientState]);

  useEffect(() => {
    if (leaseState.kind !== 'leader' || !session) return;
    const tick = () => {
      acquireLease(session.id, participant.id, participant.name, leaseState.token)
        .then((result) => {
          if (!result.ok && result.reason === 'rejected-active-lease') {
            setLeaseState({ kind: 'lost', reason: '租约已被接管' });
            setClientState('lease-lost');
          } else if (result.ok && result.lease) {
            setLeaseState({ kind: 'leader', token: result.lease.token, expiresAt: result.lease.expiresAt });
          }
        })
        .catch(() => undefined);
    };
    heartbeatRef.current = window.setInterval(tick, LEASE_HEARTBEAT_MS);
    return () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    };
  }, [leaseState.kind, leaseState.kind === 'leader' ? leaseState.token : 0, session, participant.id, participant.name]);

  const handleTakeover = useCallback(async () => {
    if (!session) return;
    const requestToken = leaseState.kind === 'leader' ? leaseState.token : 0;
    const result = await acquireLease(session.id, participant.id, participant.name, requestToken);
    if (result.ok && result.lease) {
      setClientState('following');
      applySession((await fetchSession(session.id)));
    } else {
      setMessage(`接管失败：${result.reason}`);
    }
  }, [session, leaseState, participant.id, participant.name, applySession]);

  const handleAdvance = useCallback(async () => {
    if (!session || !currentCursor || leaseState.kind !== 'leader') return;
    try {
      const updated = await advanceCursor(session.id, {
        participantId: participant.id,
        fencingToken: leaseState.token,
        cursor: currentCursor,
        label: live ? '实时' : `游标 #${currentCursor.ingestSequence}`,
        snapshotId: null
      });
      applySession(updated);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }, [session, currentCursor, leaseState, participant.id, live, applySession]);

  const handleSeal = useCallback(async () => {
    if (!session || !currentCursor || leaseState.kind !== 'leader') return;
    try {
      const updated = await sealSessionSnapshot(session.id, {
        participantId: participant.id,
        fencingToken: leaseState.token,
        cursor: currentCursor,
        label: sealedLabel || `共同游标 #${currentCursor.ingestSequence}`,
        notes: ''
      });
      applySession(updated);
      setMessage('已封存新的共同快照');
    } catch (err) {
      setMessage((err as Error).message);
    }
  }, [session, currentCursor, leaseState, participant.id, sealedLabel, applySession]);

  const handleAddNote = useCallback(async () => {
    if (!session || noteDraft.trim().length === 0) return;
    const clientNoteId = `${participant.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await addSessionNote({
        sessionId: session.id,
        participantId: participant.id,
        participantName: participant.name,
        text: noteDraft.trim(),
        clientNoteId
      });
      setNoteDraft('');
      const refreshed = await fetchSession(session.id);
      applySession(refreshed);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }, [session, noteDraft, participant.id, participant.name, applySession]);

  const toggleFollow = useCallback(() => {
    if (clientState === 'following') {
      setClientState('independent');
    } else {
      setClientState('following');
      if (session?.sharedCursor) onFollowCursor(session.sharedCursor.cursor);
    }
  }, [clientState, session, onFollowCursor]);

  const sortedNotes = useMemo<readonly SessionNoteEntry[]>(
    () =>
      session
        ? [...session.notes].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.id.localeCompare(b.id)))
        : [],
    [session]
  );

  if (!anchorSnapshot) {
    return (
      <div className="collab-panel">
        <div className="empty">先在"事故快照对比"中封存 A/B 快照，即可发起跨班共享会话。</div>
        <div className="collab-identity">
          <label className="small muted">我的值班身份（可先设置）</label>
          <div className="identity-row">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => nameDraft.trim() && setName(nameDraft.trim())}
              data-testid="participant-name"
            />
          </div>
          <div className="muted small">id: {participant.id.slice(0, 8)}</div>
        </div>
      </div>
    );
  }

  const stateLabel =
    clientState === 'following'
      ? '跟随负责人'
      : clientState === 'lease-lost'
        ? '已失去租约'
        : '独立查看';
  const stateClass = clientState === 'following' ? 'live' : clientState === 'lease-lost' ? 'paused' : '';

  return (
    <div className="collab-panel">
      <div className="collab-head">
        <div>
          <div className="muted small">交接锚点</div>
          <div className="anchor-hash" data-testid="anchor-digest">
            {anchorSnapshot.digestA.recordsDigest.slice(0, 10)} → {anchorSnapshot.digestB.recordsDigest.slice(0, 10)}
          </div>
        </div>
        <span className={`badge ${stateClass}`} data-testid="collab-state">{stateLabel}</span>
      </div>

      <div className="collab-identity">
        <label className="small muted">我的值班身份</label>
        <div className="identity-row">
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft.trim() && setName(nameDraft.trim())}
            data-testid="participant-name"
          />
          {!session ? (
            <button className="primary" onClick={startSession}>发起会话</button>
          ) : null}
        </div>
        <div className="muted small">id: {participant.id.slice(0, 8)}</div>
      </div>

      {session ? (
        <>
          <div className="lease-box" data-testid="lease-box">
            <div>
              <span className="muted small">负责人：</span>
              <strong>
                {leaseState.kind === 'leader'
                  ? `${participant.name}（你）#${leaseState.token}`
                  : leaseState.kind === 'follower'
                    ? `${leaseState.leaderName}`
                    : leaseState.kind === 'lost'
                      ? `（已失去）${leaseState.reason}`
                      : '无人持有'}
              </strong>
            </div>
            <div className="lease-actions">
              {leaseState.kind !== 'leader' ? (
                <button onClick={handleTakeover} data-testid="takeover">
                  {leaseState.kind === 'follower' ? '接管租约' : '获取租约'}
                </button>
              ) : (
                <span className="chip add">持有 fencing #{leaseState.token}</span>
              )}
              <button onClick={toggleFollow} data-testid="toggle-follow">
                {clientState === 'following' ? '独立查看' : '跟随负责人'}
              </button>
            </div>
          </div>

          {session.sharedCursor ? (
            <div className="shared-cursor">
              <div className="muted small">共同游标：{session.sharedCursor.label}</div>
              <div>seq <b>{session.sharedCursor.cursor.ingestSequence}</b> · {session.sharedCursor.updatedBy.slice(0, 8)}</div>
              <button
                onClick={() => onFollowCursor(session.sharedCursor!.cursor)}
                data-testid="jump-shared"
              >
                跳到共同游标
              </button>
            </div>
          ) : null}

          {leaseState.kind === 'leader' ? (
            <div className="leader-actions">
              <button onClick={handleAdvance} data-testid="advance-cursor" disabled={!currentCursor}>
                推进共同游标到当前位置
              </button>
              <div className="seal-row">
                <input
                  placeholder="新快照标签"
                  value={sealedLabel}
                  onChange={(e) => setSealedLabel(e.target.value)}
                />
                <button className="primary" onClick={handleSeal} data-testid="seal-in-session">
                  封存后续快照
                </button>
              </div>
            </div>
          ) : (
            <div className="muted small">只有持有租约的负责人可以封存快照或推进共同游标。</div>
          )}

          <div className="notes-block">
            <div className="section-label">协作备注（确定性归并）</div>
            <ul className="note-list" data-testid="note-list">
              {sortedNotes.map((note) => (
                <li key={note.id} className="note-item" data-testid={`note-${note.seq}`}>
                  <div>
                    <strong>{note.participantName}</strong>
                    <span className="muted small"> #{note.seq}</span>
                  </div>
                  <div>{note.text}</div>
                </li>
              ))}
              {sortedNotes.length === 0 ? <li className="muted small">暂无备注</li> : null}
            </ul>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={2}
              placeholder="补充调查结论…（所有人按 seq 归并）"
              data-testid="note-input"
            />
            <button onClick={handleAddNote} data-testid="add-note">追加备注</button>
          </div>
        </>
      ) : null}
      {message ? <div className="snap-message">{message}</div> : null}
    </div>
  );
}
