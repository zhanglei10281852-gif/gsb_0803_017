import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReplayCursor,
  ReplayView,
  SpanVersionExplanation,
  WsServerMessage,
} from '@shared/contracts.js';
import { emptyHead } from '@shared/contracts.js';
import {
  connectLive,
  fetchHead,
  fetchReplay,
  fetchSpanVersions,
  startSample,
  stopSample,
  sendWs,
} from './api.js';
import { Topology3D, type Selection } from './components/Topology3D.js';
import { SpanList } from './components/SpanList.js';
import { SpanDetail } from './components/SpanDetail.js';
import { Timeline } from './components/Timeline.js';
import { SnapshotPanel } from './components/SnapshotPanel.js';
import { SessionBar } from './components/SessionBar.js';
import { useSession } from './hooks/useSession.js';

const EMPTY_VIEW: ReplayView = {
  cursor: emptyHead(),
  head: emptyHead(),
  totalLedgerRecords: 0,
  spans: [],
  services: [],
  edges: [],
  traces: [],
};

export function App() {
  const [head, setHead] = useState<ReplayCursor>(emptyHead());
  const [cursor, setCursor] = useState<ReplayCursor>(emptyHead());
  const [view, setView] = useState<ReplayView>(EMPTY_VIEW);
  const [isLive, setIsLive] = useState(true);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [versions, setVersions] = useState<SpanVersionExplanation[]>([]);
  const [sampleRunning, setSampleRunning] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [wsInstance, setWsInstance] = useState<WebSocket | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const cursorRef = useRef(cursor);
  const isLiveRef = useRef(isLive);
  const selectedRef = useRef(selected);
  const abortRef = useRef<AbortController | null>(null);
  const versionsAbortRef = useRef<AbortController | null>(null);
  const fetchTimerRef = useRef<number | null>(null);
  const broadcastTimerRef = useRef<number | null>(null);

  const onSharedCursor = useCallback((c: ReplayCursor) => {
    setIsLive(false);
    setCursor(c);
  }, []);

  const session = useSession({ ws: wsInstance, onSharedCursor });

  useEffect(() => { cursorRef.current = cursor; }, [cursor]);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const loadView = useCallback(async (c: ReplayCursor) => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const v = await fetchReplay(c);
      if (!ac.signal.aborted) {
        setView(v);
        setHead(v.head);
      }
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    }
  }, []);

  const scheduleViewLoad = useCallback((c: ReplayCursor) => {
    if (fetchTimerRef.current !== null) {
      window.clearTimeout(fetchTimerRef.current);
    }
    fetchTimerRef.current = window.setTimeout(() => {
      fetchTimerRef.current = null;
      void loadView(c);
    }, 60);
  }, [loadView]);

  const loadVersions = useCallback(async (sel: Selection | null, c: ReplayCursor) => {
    if (versionsAbortRef.current) versionsAbortRef.current.abort();
    if (!sel) {
      setVersions([]);
      return;
    }
    const ac = new AbortController();
    versionsAbortRef.current = ac;
    try {
      const res = await fetchSpanVersions(sel.traceId, sel.spanId, c);
      if (!ac.signal.aborted) setVersions(res.versions);
    } catch {
      if (!ac.signal.aborted) setVersions([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchHead()
      .then((h) => {
        if (cancelled) return;
        setHead(h.head);
        setCursor(h.head);
        setIsLive(true);
        return loadView(h.head);
      })
      .catch((e: unknown) => setError((e as Error).message));

    const ws = connectLive((msg: WsServerMessage) => {
      if (msg.type === 'snapshot') {
        setHead(msg.head);
        setWsConnected(true);
        if (isLiveRef.current) {
          setCursor(msg.head);
          scheduleViewLoad(msg.head);
        }
      } else if (msg.type === 'record') {
        setHead(msg.head);
        if (isLiveRef.current) {
          setCursor(msg.head);
          scheduleViewLoad(msg.head);
        }
      } else if (msg.type === 'sample') {
        setSampleRunning(msg.running);
      }
    });
    wsRef.current = ws;
    setWsInstance(ws);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);

    return () => {
      cancelled = true;
      ws.close();
      if (abortRef.current) abortRef.current.abort();
      if (versionsAbortRef.current) versionsAbortRef.current.abort();
      if (fetchTimerRef.current !== null) window.clearTimeout(fetchTimerRef.current);
      if (broadcastTimerRef.current !== null) window.clearTimeout(broadcastTimerRef.current);
    };
  }, [loadView, scheduleViewLoad]);

  useEffect(() => {
    scheduleViewLoad(cursor);
  }, [cursor, scheduleViewLoad]);

  useEffect(() => {
    void loadVersions(selected, cursor);
  }, [selected, cursor, loadVersions]);

  const currentSpan = useMemo(() => {
    if (!selected) return null;
    return view.spans.find(
      (s) => s.traceId === selected.traceId && s.spanId === selected.spanId,
    ) ?? null;
  }, [view.spans, selected]);

  const handleCursorChange = useCallback((c: ReplayCursor) => {
    setIsLive(false);
    session.setFollowing(false);
    setCursor(c);
  }, [session]);

  useEffect(() => {
    if (!session.isLeader || session.followState !== 'following') return;
    if (broadcastTimerRef.current !== null) window.clearTimeout(broadcastTimerRef.current);
    broadcastTimerRef.current = window.setTimeout(() => {
      broadcastTimerRef.current = null;
      if (wsRef.current && session.fencingToken !== null) {
        sendWs(wsRef.current, {
          type: 'advance-cursor',
          clientId: session.clientId,
          fencingToken: session.fencingToken,
          cursor,
        });
      }
    }, 250);
  }, [cursor, session]);

  const goLive = useCallback(() => {
    setIsLive(true);
    setCursor(head);
  }, [head]);

  const togglePause = useCallback(() => {
    if (isLive) {
      setIsLive(false);
    } else {
      goLive();
    }
  }, [isLive, goLive]);

  const handleSampleStart = useCallback(async () => {
    try {
      const res = await startSample();
      setSampleRunning(res.running);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const handleSampleStop = useCallback(async () => {
    try {
      await stopSample();
      setSampleRunning(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const handleSelect = useCallback((sel: Selection | null) => {
    setSelected(sel);
  }, []);

  const handleJumpToCursor = useCallback((c: ReplayCursor) => {
    setIsLive(false);
    setCursor(c);
  }, []);

  return (
    <div className={`app ${showSnapshots ? 'with-snapshots' : ''}`}>
      <header className="topbar">
        <h1>Trace Replay Platform</h1>
        <span className={`badge ${wsConnected ? 'live' : 'paused'}`}>
          {wsConnected ? '● live stream' : '○ disconnected'}
        </span>
        <span className="badge">{view.totalLedgerRecords} ledger records</span>
        <span className="badge">{view.services.length} services</span>
        <span className="badge">{view.spans.length} current spans</span>
        {view.traces.some((t) => t.hasError) && (
          <span className="badge" style={{ color: 'var(--error)', borderColor: 'var(--error)' }}>
            {view.traces.filter((t) => t.hasError).length} traces with errors
          </span>
        )}
        <div className="spacer" />
        <button className={showSnapshots ? 'active' : ''} onClick={() => setShowSnapshots((v) => !v)}>
          📸 Compare
        </button>
        <button className={isLive ? 'active' : ''} onClick={goLive}>
          ▶ Live
        </button>
        <button className={!isLive ? 'active' : ''} onClick={togglePause}>
          {isLive ? '⏸ Pause' : '▶ Resume'}
        </button>
        {sampleRunning ? (
          <button className="danger" onClick={handleSampleStop}>■ Stop sample</button>
        ) : (
          <button onClick={handleSampleStart}>▶ Play sample stream</button>
        )}
      </header>

      <SessionBar session={session} />

      <SpanList spans={view.spans} selected={selected} onSelect={handleSelect} />

      <div className="panel view-panel">
        <Topology3D view={view} selected={selected} onSelect={handleSelect} />
        <div className="view-overlay">
          <b>Cursor</b><br />
          eventTime: {cursor.eventTime}<br />
          ingestSequence: {cursor.ingestSequence}<br />
          {isLive ? <span style={{ color: 'var(--ok)' }}>Following live head</span> : <span style={{ color: 'var(--warn)' }}>Paused — scrub timeline</span>}
          {error && <div style={{ color: 'var(--error)', marginTop: 6 }}>{error}</div>}
        </div>
      </div>

      <SpanDetail selected={selected} currentSpan={currentSpan} versions={versions} />

      {showSnapshots && (
        <div className="snapshot-drawer">
          <SnapshotPanel
            cursor={cursor}
            onJumpTo={handleJumpToCursor}
            fencing={session.fencingToken !== null ? { clientId: session.clientId, token: session.fencingToken } : null}
            leaderName={session.leaderName}
            isLeader={session.isLeader}
            leaseActive={!!session.lease}
          />
        </div>
      )}

      <Timeline view={view} cursor={cursor} head={head} isLive={isLive} onCursorChange={handleCursorChange} />
    </div>
  );
}
