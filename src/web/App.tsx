import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectionView,
  ProjectedSpan,
  ReplayCursor,
  SessionState,
  ParticipantRole,
  IncidentSnapshot,
} from '../shared/contract';
import { effectiveCursor } from '../shared/collaboration';
import { fetchBounds, fetchView, openLive, listSnapshots, type Bounds } from './api';
import { TopologyScene } from './TopologyScene';
import { SnapshotPanel } from './SnapshotPanel';
import { CollaborationPanel } from './CollaborationPanel';

type Mode = 'live' | 'paused';

interface RoleInfo {
  role: ParticipantRole;
  followOwner: boolean;
  holder: string;
  sessionId: number | null;
  fencingToken: number | null;
}

const EMPTY_BOUNDS: Bounds = { minEventTimeMs: 0, maxEventTimeMs: 0, maxIngestSequence: 0 };

export function App(): JSX.Element {
  const [mode, setMode] = useState<Mode>('live');
  const [bounds, setBounds] = useState<Bounds>(EMPTY_BOUNDS);
  // The client's own (independent) cursor, driven by the timeline scrub.
  const [localCursor, setLocalCursor] = useState<ReplayCursor>({ eventTimeMs: 0, ingestSequence: 0 });
  const [view, setView] = useState<ProjectionView | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Collaboration state (App owns it so it can drive the follow cursor).
  const [session, setSession] = useState<SessionState | null>(null);
  const [roleInfo, setRoleInfo] = useState<RoleInfo>({
    role: 'independent',
    followOwner: true,
    holder: '',
    sessionId: null,
    fencingToken: null,
  });
  const [anchors, setAnchors] = useState<IncidentSnapshot[]>([]);

  const modeRef = useRef<Mode>('live');
  modeRef.current = mode;
  const sessionRef = useRef<SessionState | null>(null);
  sessionRef.current = session;
  const refetchSessionRef = useRef<() => void>(() => {});

  // Live head: while following the live feed, the local cursor tracks bounds.
  const applyBounds = useCallback((b: Bounds) => {
    setBounds(b);
    if (modeRef.current === 'live') {
      setLocalCursor({ eventTimeMs: b.maxEventTimeMs, ingestSequence: b.maxIngestSequence });
    }
  }, []);

  const refreshAnchors = useCallback(() => {
    listSnapshots()
      .then(setAnchors)
      .catch(() => {
        /* anchors are optional; ignore */
      });
  }, []);

  // Initial load + websocket follow (live records AND session signals).
  useEffect(() => {
    let cancelled = false;
    fetchBounds()
      .then((b) => {
        if (!cancelled) applyBounds(b);
      })
      .catch((e: unknown) => setError(String(e)));
    refreshAnchors();
    const close = openLive(
      (msg) => {
        if (msg.type === 'session') {
          // Only adopt signals for the session this client has joined.
          if (sessionRef.current && msg.state.session.id === sessionRef.current.session.id) {
            setSession(msg.state);
          }
        } else {
          applyBounds(msg.bounds);
          if (msg.type === 'live') refreshAnchors();
        }
      },
      () => {
        // On (re)connect, refetch authoritative state — socket is best-effort.
        fetchBounds().then(applyBounds).catch(() => undefined);
        refetchSessionRef.current();
      },
    );
    return () => {
      cancelled = true;
      close();
    };
  }, [applyBounds, refreshAnchors]);

  // The cursor actually displayed: a follower tracks the owner's shared cursor,
  // everyone else uses their own local cursor.
  const displayCursor: ReplayCursor = useMemo(() => {
    if (session && roleInfo.role === 'following') {
      return effectiveCursor({
        role: 'following',
        followOwner: true,
        sharedCursor: session.sharedCursor,
        localCursor,
      });
    }
    return localCursor;
  }, [session, roleInfo.role, localCursor]);

  // Whenever the displayed cursor changes, fetch the reproducible view for it.
  useEffect(() => {
    let cancelled = false;
    fetchView(displayCursor)
      .then((v) => {
        if (!cancelled) {
          setView(v);
          setError(null);
        }
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [displayCursor.eventTimeMs, displayCursor.ingestSequence]);

  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next = m === 'live' ? 'paused' : 'live';
      if (next === 'live') {
        setLocalCursor({ eventTimeMs: bounds.maxEventTimeMs, ingestSequence: bounds.maxIngestSequence });
      }
      return next;
    });
  }, [bounds]);

  const onScrubTime = useCallback((value: number) => {
    setMode('paused');
    setLocalCursor((c) => ({ ...c, eventTimeMs: value }));
  }, []);
  const onScrubIngest = useCallback((value: number) => {
    setMode('paused');
    setLocalCursor((c) => ({ ...c, ingestSequence: value }));
  }, []);

  const selectedSpan = useMemo<ProjectedSpan | null>(() => {
    if (!view || selectedSpanId === null) return null;
    return view.spans.find((s) => s.spanId === selectedSpanId) ?? null;
  }, [view, selectedSpanId]);

  const errorCount = view ? view.spans.filter((s) => s.status === 'error').length : 0;

  // Following clients cannot scrub the shared cursor themselves.
  const scrubDisabled = session !== null && roleInfo.role === 'following';
  // Writer credential passed to the snapshot sealer when owning the lease.
  const writerCred =
    session !== null && roleInfo.role === 'owner' && roleInfo.fencingToken !== null
      ? { sessionId: session.session.id, holder: roleInfo.holder, fencingToken: roleInfo.fencingToken }
      : null;
  // A seal is blocked when in a session but not the owner (would be fenced out).
  const sealBlockedReason =
    session !== null && roleInfo.role !== 'owner'
      ? roleInfo.role === 'lost-lease'
        ? '你已失去租约，需重新接管后才能封存'
        : '仅负责人可封存；请先接管租约'
      : null;

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="dot" /> 分布式链路事故回放平台
        </div>
        <div className="controls">
          <button
            type="button"
            className={mode === 'live' ? 'btn live' : 'btn'}
            onClick={toggleMode}
            data-testid="mode-toggle"
          >
            {mode === 'live' ? '● 实时跟随中（点击暂停）' : '⏸ 已暂停回放（点击跟随）'}
          </button>
          <span className="mode-badge" data-testid="mode-badge">
            {mode === 'live' ? 'LIVE' : 'REPLAY'}
          </span>
        </div>
      </header>

      <section className="timeline" data-testid="timeline">
        <div className="scrub">
          <label>
            事件时间 (incident timeline)
            <input
              type="range"
              min={bounds.minEventTimeMs}
              max={Math.max(bounds.maxEventTimeMs, bounds.minEventTimeMs)}
              value={displayCursor.eventTimeMs}
              disabled={scrubDisabled}
              onChange={(e) => onScrubTime(Number(e.target.value))}
              data-testid="scrub-time"
            />
            <output>{formatTime(displayCursor.eventTimeMs, bounds.minEventTimeMs)}</output>
          </label>
          <label>
            采集进度 (ingestSequence — 已到达的知识)
            <input
              type="range"
              min={0}
              max={Math.max(bounds.maxIngestSequence, 0)}
              value={displayCursor.ingestSequence}
              disabled={scrubDisabled}
              onChange={(e) => onScrubIngest(Number(e.target.value))}
              data-testid="scrub-ingest"
            />
            <output data-testid="ingest-value">
              #{displayCursor.ingestSequence} / {bounds.maxIngestSequence}
            </output>
          </label>
        </div>
        {scrubDisabled && (
          <div className="follow-note" data-testid="follow-note">
            正在跟随负责人的共同游标（时间线只读）；切换为“独立查看”后可自行拖动。
          </div>
        )}
        <div className="summary" data-testid="view-summary">
          {view ? (
            <>
              <span>{view.spans.length} spans</span>
              <span className={errorCount > 0 ? 'err' : ''}>{errorCount} errors</span>
              <span>{view.services.length} services</span>
            </>
          ) : (
            <span>加载中…</span>
          )}
        </div>
      </section>

      {error && <div className="error-banner" data-testid="error-banner">{error}</div>}

      <main className="main">
        <div className="scene-panel">
          <TopologyScene
            view={view}
            selectedSpanId={selectedSpanId}
            onSelect={setSelectedSpanId}
          />
          <div className="legend">
            <span><i className="sw ok" />正常</span>
            <span><i className="sw errpath" />错误传播路径</span>
            <span><i className="sw err" />错误源</span>
          </div>
        </div>

        <aside className="side">
          <div className="span-list" data-testid="span-list">
            <h3>Span 列表</h3>
            {view && view.spans.length > 0 ? (
              <ul>
                {view.spans.map((s) => (
                  <li
                    key={`${s.traceId}:${s.spanId}`}
                    className={[
                      s.spanId === selectedSpanId ? 'selected' : '',
                      s.status === 'error' ? 'is-error' : s.onErrorPath ? 'is-errpath' : '',
                    ].join(' ')}
                    onClick={() => setSelectedSpanId(s.spanId)}
                    data-testid={`span-item-${s.spanId}`}
                  >
                    <span className="svc">{s.service}</span>
                    <span className="op">{s.operation}</span>
                    <span className="rev">r{s.revision}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">该回放位置暂无 span</p>
            )}
          </div>

          <div className="detail" data-testid="span-detail">
            <h3>版本详情</h3>
            {selectedSpan ? (
              <SpanDetail span={selectedSpan} />
            ) : (
              <p className="empty">选择一个 span 查看其当前版本生效的理由</p>
            )}
          </div>

          <SnapshotPanel
            cursor={displayCursor}
            baseEventTimeMs={bounds.minEventTimeMs}
            writer={writerCred}
            sealBlockedReason={sealBlockedReason}
            onSealed={refreshAnchors}
          />

          <CollaborationPanel
            localCursor={displayCursor}
            session={session}
            setSession={setSession}
            onRoleChange={setRoleInfo}
            anchors={anchors.map((a) => ({ id: a.id, label: a.label, digest: a.provenance.digest }))}
            registerRefetch={(fn) => {
              refetchSessionRef.current = fn;
            }}
          />
        </aside>
      </main>
    </div>
  );
}

function SpanDetail({ span }: { span: ProjectedSpan }): JSX.Element {
  return (
    <div className="detail-body">
      <dl>
        <dt>Service</dt><dd>{span.service}</dd>
        <dt>Operation</dt><dd>{span.operation}</dd>
        <dt>Trace</dt><dd className="mono">{span.traceId}</dd>
        <dt>Span</dt><dd className="mono">{span.spanId}</dd>
        <dt>Parent</dt><dd className="mono">{span.parentSpanId ?? '(root)'}</dd>
        <dt>Status</dt>
        <dd className={span.status === 'error' ? 'err' : 'ok'}>
          {span.status}{span.errorKind ? ` · ${span.errorKind}` : ''}
        </dd>
        <dt>Revision</dt><dd data-testid="detail-revision">r{span.revision}</dd>
        <dt>Ingest #</dt><dd>{span.ingestSequence}</dd>
        <dt>Duration</dt><dd>{span.durationMs} ms</dd>
      </dl>
      <div className="reason" data-testid="version-reason">
        <h4>为何显示此版本</h4>
        <p>{span.versionReason.explanation}</p>
        <ul>
          <li>已知修订数：{span.versionReason.knownRevisions}</li>
          <li>全局最高修订：r{span.versionReason.latestRevisionEver}</li>
          {span.versionReason.supersededLater && (
            <li className="warn" data-testid="superseded-note">
              存在更新的修订，但它在当前回放位置之后到达，因此被隐藏。
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function formatTime(ms: number, base: number): string {
  const rel = Math.max(0, ms - base);
  return `+${rel} ms`;
}
