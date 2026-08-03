import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InvestigationNote,
  ParticipantRole,
  ReplayCursor,
  SessionState,
} from '../shared/contract';
import { classifyRole, nextLamport } from '../shared/collaboration';
import {
  acquireLease,
  addNote,
  advanceSharedCursor,
  createSession,
  fetchSession,
  releaseLease,
  renewLease,
} from './api';

/** Persisted per-tab identity + which session/lease this client last held. */
interface LocalIdentity {
  holder: string;
  sessionId: number | null;
  fencingToken: number | null;
  followOwner: boolean;
  localClock: number;
}

const STORE_KEY = 'replay.collab.identity';

function loadIdentity(): LocalIdentity {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaults(), ...(JSON.parse(raw) as Partial<LocalIdentity>) };
  } catch {
    /* ignore */
  }
  return defaults();
}
function defaults(): LocalIdentity {
  const holder = `dispatcher-${Math.random().toString(36).slice(2, 6)}`;
  return { holder, sessionId: null, fencingToken: null, followOwner: true, localClock: 0 };
}

interface Props {
  /** The local (independent) cursor the main view is currently showing. */
  localCursor: ReplayCursor;
  /** Latest session state (App owns it so it can drive the follow cursor). */
  session: SessionState | null;
  setSession: (s: SessionState | null) => void;
  /** Report role + whether this client is following the owner's cursor. */
  onRoleChange: (info: { role: ParticipantRole; followOwner: boolean; holder: string; sessionId: number | null; fencingToken: number | null }) => void;
  /** Snapshots available as handoff anchors: id + digest. */
  anchors: Array<{ id: number; label: string; digest: string }>;
  /** Register a reconnect refetch hook so App can call it after socket reopen. */
  registerRefetch: (fn: () => void) => void;
}

export function CollaborationPanel({
  localCursor,
  session,
  setSession,
  onRoleChange,
  anchors,
  registerRefetch,
}: Props): JSX.Element {
  const [identity, setIdentity] = useState<LocalIdentity>(loadIdentity);
  const [noteBody, setNoteBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const identityRef = useRef(identity);
  identityRef.current = identity;

  // Optional lease TTL override via ?leaseTtlMs=… — lets end-to-end tests make
  // takeover-after-expiry deterministic without waiting the full default TTL.
  const leaseTtlMs = useMemo(() => {
    const raw = new URLSearchParams(location.search).get('leaseTtlMs');
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, []);

  const persist = useCallback((next: LocalIdentity) => {
    setIdentity(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  // Tick a local clock so lease-expiry driven role changes surface promptly.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Refetch authoritative session state (called on reconnect + on mount).
  const refetch = useCallback(async () => {
    const id = identityRef.current.sessionId;
    if (id === null) return;
    try {
      const s = await fetchSession(id);
      setSession(s);
    } catch (e) {
      setErr(String(e));
    }
  }, [setSession]);

  useEffect(() => {
    registerRefetch(() => void refetch());
    void refetch();
  }, [registerRefetch, refetch]);

  // Derive role from the authoritative session state + local credentials.
  const role: ParticipantRole = session
    ? classifyRole({
        state: session,
        localHolder: identity.holder,
        localFencingToken: identity.sessionId === session.session.id ? identity.fencingToken : null,
        followOwner: identity.followOwner,
        nowMs,
      })
    : 'independent';

  // Report role upward so App can choose the effective cursor (follow vs local).
  useEffect(() => {
    onRoleChange({
      role,
      followOwner: identity.followOwner,
      holder: identity.holder,
      sessionId: identity.sessionId,
      fencingToken: identity.fencingToken,
    });
  }, [role, identity.followOwner, identity.holder, identity.sessionId, identity.fencingToken, onRoleChange]);

  // While owning the lease, auto-renew before it expires so the writer keeps it.
  // Skipped when a short TTL override is set (tests want deterministic expiry).
  useEffect(() => {
    if (role !== 'owner' || session === null || identity.fencingToken === null) return;
    if (leaseTtlMs !== undefined) return;
    const t = setInterval(() => {
      void (async () => {
        try {
          const s = await renewLease(session.session.id, identity.holder, identity.fencingToken!);
          setSession(s);
        } catch {
          // Renewal failed -> we were taken over. Refetch to reflect lost lease.
          void refetch();
        }
      })();
    }, 8000);
    return () => clearInterval(t);
  }, [role, session, identity.fencingToken, identity.holder, leaseTtlMs, setSession, refetch]);

  const onCreateSession = useCallback(
    async (anchorId: number, digest: string) => {
      setErr(null);
      try {
        const s = await createSession({ label: `handoff-${anchorId}`, anchorSnapshotId: anchorId, anchorDigest: digest });
        setSession(s);
        persist({ ...identityRef.current, sessionId: s.session.id, fencingToken: null });
      } catch (e) {
        setErr(String(e));
      }
    },
    [persist, setSession],
  );

  const onJoin = useCallback(
    async (id: number) => {
      setErr(null);
      try {
        const s = await fetchSession(id);
        if (s === null) {
          setErr(`会话 #${id} 不存在`);
          return;
        }
        setSession(s);
        persist({ ...identityRef.current, sessionId: id, fencingToken: null });
      } catch (e) {
        setErr(String(e));
      }
    },
    [persist, setSession],
  );

  const onTakeover = useCallback(async () => {
    if (session === null) return;
    setErr(null);
    try {
      const s = await acquireLease(session.session.id, identity.holder, leaseTtlMs);
      setSession(s);
      const token = s.lease?.holder === identity.holder ? s.lease.fencingToken : null;
      persist({ ...identityRef.current, sessionId: session.session.id, fencingToken: token });
    } catch (e) {
      setErr(String(e));
    }
  }, [session, identity.holder, leaseTtlMs, persist, setSession]);

  const onRelease = useCallback(async () => {
    if (session === null || identity.fencingToken === null) return;
    setErr(null);
    try {
      const s = await releaseLease(session.session.id, identity.holder, identity.fencingToken);
      setSession(s);
      persist({ ...identityRef.current, fencingToken: null });
    } catch (e) {
      setErr(String(e));
    }
  }, [session, identity.fencingToken, identity.holder, persist, setSession]);

  // Owner pins the shared cursor to the current local cursor.
  const onPushCursor = useCallback(async () => {
    if (session === null || identity.fencingToken === null) return;
    setErr(null);
    try {
      const s = await advanceSharedCursor(session.session.id, identity.holder, identity.fencingToken, localCursor);
      setSession(s);
    } catch (e) {
      setErr(String(e));
    }
  }, [session, identity.fencingToken, identity.holder, localCursor, setSession]);

  const onToggleFollow = useCallback(() => {
    persist({ ...identityRef.current, followOwner: !identityRef.current.followOwner });
  }, [persist]);

  const onAddNote = useCallback(async () => {
    if (session === null || noteBody.trim() === '') return;
    setErr(null);
    const lamport = nextLamport(identity.localClock, session.notes);
    const note: InvestigationNote = {
      id: `${identity.holder}-${lamport}-${Math.random().toString(36).slice(2, 6)}`,
      author: identity.holder,
      lamport,
      body: noteBody.trim(),
      createdAtMs: Date.now(),
    };
    try {
      const s = await addNote(session.session.id, note);
      setSession(s);
      persist({ ...identityRef.current, localClock: lamport });
      setNoteBody('');
    } catch (e) {
      setErr(String(e));
    }
  }, [session, noteBody, identity.localClock, identity.holder, persist, setSession]);

  return (
    <div className="collab-panel" data-testid="collab-panel">
      <div className="collab-header">
        <h3>跨班协作</h3>
        <span className="me" data-testid="collab-holder">{identity.holder}</span>
      </div>

      <RoleBadge role={role} session={session} nowMs={nowMs} />

      {session === null ? (
        <div className="collab-join">
          <p className="hint">以已封存快照为交接锚点，创建或加入共享调查会话：</p>
          <div className="anchor-list">
            {anchors.length === 0 ? (
              <span className="empty">先封存一个快照作为锚点。</span>
            ) : (
              anchors.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="btn small"
                  onClick={() => void onCreateSession(a.id, a.digest)}
                  data-testid={`create-session-${a.id}`}
                >
                  基于快照{a.label}(#{a.id})开会话
                </button>
              ))
            )}
          </div>
          <JoinById onJoin={(id) => void onJoin(id)} />
        </div>
      ) : (
        <>
          <div className="collab-anchor" data-testid="collab-anchor">
            会话 #{session.session.id} · 锚点快照 #{session.session.anchorSnapshotId} ·{' '}
            <span className="mono">{session.session.anchorDigest.slice(0, 10)}…</span>
          </div>

          <div className="collab-controls">
            {role === 'owner' ? (
              <>
                <button type="button" className="btn live" onClick={() => void onPushCursor()} data-testid="push-cursor">
                  把当前游标设为共同游标
                </button>
                <button type="button" className="btn" onClick={() => void onRelease()} data-testid="release-lease">
                  释放负责人租约
                </button>
              </>
            ) : (
              <button type="button" className="btn live" onClick={() => void onTakeover()} data-testid="takeover-lease">
                {role === 'lost-lease' ? '重新接管负责人' : '接管为负责人'}
              </button>
            )}
            {role !== 'owner' && (
              <button
                type="button"
                className={identity.followOwner ? 'btn live' : 'btn'}
                onClick={onToggleFollow}
                data-testid="toggle-follow"
              >
                {identity.followOwner ? '正在跟随负责人（点击独立查看）' : '独立查看（点击跟随负责人）'}
              </button>
            )}
          </div>

          <div className="collab-shared" data-testid="shared-cursor">
            共同游标：采集 #{session.sharedCursor.ingestSequence} · 事件 {session.sharedCursor.eventTimeMs} ·
            fencing #{session.sharedCursorToken} · 最高 token #{session.highestFencingToken}
          </div>

          <div className="collab-notes" data-testid="collab-notes">
            <h4>并发调查备注（确定性归并）</h4>
            <div className="note-input">
              <input
                type="text"
                value={noteBody}
                placeholder="写一条备注（不受租约限制，多人并发确定性合并）"
                onChange={(e) => setNoteBody(e.target.value)}
                data-testid="note-input"
              />
              <button type="button" className="btn small" onClick={() => void onAddNote()} data-testid="add-note">
                添加
              </button>
            </div>
            <ul>
              {session.notes.map((n) => (
                <li key={n.id} data-testid={`note-${n.id}`}>
                  <span className="note-order">L{n.lamport}</span>
                  <span className="note-author">{n.author}</span>
                  <span className="note-body">{n.body}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {err && <div className="error-banner" data-testid="collab-error">{err}</div>}
    </div>
  );
}

function RoleBadge({ role, session, nowMs }: { role: ParticipantRole; session: SessionState | null; nowMs: number }): JSX.Element {
  const owner = session?.lease && session.lease.expiresAtMs > nowMs ? session.lease.holder : null;
  const map: Record<ParticipantRole, { text: string; cls: string }> = {
    owner: { text: '● 你是负责人（可封存/推进共同游标）', cls: 'role owner' },
    following: { text: `↪ 跟随负责人 ${owner ?? '(空缺)'}`, cls: 'role following' },
    independent: { text: '◆ 独立查看（不改共同游标）', cls: 'role independent' },
    'lost-lease': { text: '✕ 已失去租约（写操作会被新负责人 fencing 拒绝）', cls: 'role lost' },
  };
  const v = map[role];
  return (
    <div className={v.cls} data-testid="role-badge" data-role={role}>
      {v.text}
      {owner && role !== 'owner' && <span className="owner-name"> · 当前负责人：{owner}</span>}
    </div>
  );
}

function JoinById({ onJoin }: { onJoin: (id: number) => void }): JSX.Element {
  const [val, setVal] = useState('');
  return (
    <div className="join-by-id">
      <input
        type="number"
        min={1}
        placeholder="按会话 ID 加入"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        data-testid="join-session-id"
      />
      <button
        type="button"
        className="btn small"
        onClick={() => {
          const id = Number(val);
          if (Number.isInteger(id) && id > 0) onJoin(id);
        }}
        data-testid="join-session"
      >
        加入
      </button>
    </div>
  );
}
