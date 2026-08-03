import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LeaseState,
  ReplayCursor,
  SessionNote,
  WsServerMessage,
} from '@shared/contracts.js';
import {
  sendWs,
  acquireLease as apiAcquire,
  releaseLease as apiRelease,
} from '../api.js';

export type FollowState = 'following' | 'independent' | 'lost-lease';

const HEARTBEAT_MS = 10_000;
const TTL_MS = 30_000;

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'client-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface UseSessionArgs {
  ws: WebSocket | null;
  onSharedCursor: (cursor: ReplayCursor) => void;
}

export interface UseSession {
  lease: LeaseState | null;
  isLeader: boolean;
  followState: FollowState;
  notes: SessionNote[];
  sharedCursor: ReplayCursor | null;
  fencingToken: number | null;
  clientId: string;
  clientName: string;
  leaderName: string;
  setClientName: (name: string) => void;
  acquire: () => Promise<void>;
  release: () => void;
  setFollowing: (v: boolean) => void;
  broadcastCursor: (cursor: ReplayCursor) => void;
  addNote: (text: string, snapshotId: string | null) => void;
}

function noteKey(n: SessionNote): string {
  return `${n.clientId}:${n.clientSeq}`;
}

function mergeNotes(existing: SessionNote[], incoming: SessionNote[]): SessionNote[] {
  const map = new Map<string, SessionNote>();
  for (const n of existing) map.set(noteKey(n), n);
  for (const n of incoming) map.set(noteKey(n), n);
  return [...map.values()].sort((a, b) =>
    a.createdAt - b.createdAt || a.clientId.localeCompare(b.clientId) || a.clientSeq - b.clientSeq,
  );
}

export function useSession(args: UseSessionArgs): UseSession {
  const { ws, onSharedCursor } = args;
  const clientIdRef = useRef<string>(generateClientId());
  const noteSeqRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const heldTokenRef = useRef<number | null>(null);
  const followRef = useRef(true);
  const cursorDirtyRef = useRef(false);

  const [clientName, setClientName] = useState('operator');
  const [lease, setLease] = useState<LeaseState | null>(null);
  const [notes, setNotes] = useState<SessionNote[]>([]);
  const [sharedCursor, setSharedCursor] = useState<ReplayCursor | null>(null);
  const [followMode, setFollowMode] = useState(true);
  const [lostLease, setLostLease] = useState(false);

  const clientId = clientIdRef.current;

  const isLeader = lease?.holderClientId === clientId;
  const leaderName = lease?.holderName ?? 'nobody';

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const handleLeaseChanged = useCallback((newLease: LeaseState | null, reason: string) => {
    const wasLeader = heldTokenRef.current !== null;
    const nowLeader = newLease?.holderClientId === clientId;
    setLease(newLease);
    if (newLease?.sharedCursor) {
      setSharedCursor(newLease.sharedCursor);
    }
    if (wasLeader && !nowLeader) {
      heldTokenRef.current = null;
      stopHeartbeat();
      setLostLease(true);
      setFollowMode(true);
      followRef.current = true;
    } else if (nowLeader) {
      heldTokenRef.current = newLease!.fencingToken;
      setLostLease(false);
    }
    if (reason === 'acquired' || reason === 'renewed') {
      setLostLease(false);
    }
  }, [clientId, stopHeartbeat]);

  const startHeartbeat = useCallback((token: number) => {
    stopHeartbeat();
    heartbeatRef.current = window.setInterval(() => {
      sendWs(wsRef.current!, {
        type: 'renew-lease',
        clientId,
        fencingToken: token,
      });
    }, HEARTBEAT_MS);
  }, [clientId, stopHeartbeat]);

  const handleWsMessage = useCallback((ev: MessageEvent) => {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as WsServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'session-state':
        setLease(msg.lease);
        setNotes(mergeNotes([], msg.notes));
        if (msg.lease?.sharedCursor) {
          setSharedCursor(msg.lease.sharedCursor);
        }
        if (msg.lease?.holderClientId === clientId) {
          heldTokenRef.current = msg.lease.fencingToken;
          startHeartbeat(msg.lease.fencingToken);
          setLostLease(false);
        }
        break;
      case 'lease-acquired':
        if (msg.lease) {
          heldTokenRef.current = msg.lease.fencingToken;
          startHeartbeat(msg.lease.fencingToken);
          setLostLease(false);
          setLease(msg.lease);
        }
        break;
      case 'lease-changed':
        handleLeaseChanged(msg.lease, msg.reason);
        break;
      case 'cursor-broadcast':
        setSharedCursor(msg.cursor);
        if (followRef.current && msg.byClientId !== clientId) {
          onSharedCursor(msg.cursor);
        }
        break;
      case 'notes-appended':
        setNotes((prev) => mergeNotes(prev, msg.notes));
        break;
      case 'lease-error':
        if (msg.error.code === 'STALE_FENCING' || msg.error.code === 'LEASE_EXPIRED' || msg.error.code === 'NOT_LEADER') {
          heldTokenRef.current = null;
          stopHeartbeat();
          setLostLease(true);
          setFollowMode(true);
          followRef.current = true;
          setLease(null);
        }
        break;
      default:
        break;
    }
  }, [clientId, handleLeaseChanged, onSharedCursor, startHeartbeat, stopHeartbeat]);

  useEffect(() => {
    wsRef.current = ws;
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    ws.addEventListener('message', handleWsMessage);
    return () => {
      ws.removeEventListener('message', handleWsMessage);
    };
  }, [ws, handleWsMessage]);

  useEffect(() => stopHeartbeat, [stopHeartbeat]);

  useEffect(() => {
    followRef.current = followMode;
  }, [followMode]);

  const acquire = useCallback(async () => {
    const res = await apiAcquire(clientId, clientName, TTL_MS);
    if (res.ok && res.lease) {
      heldTokenRef.current = res.lease.fencingToken;
      startHeartbeat(res.lease.fencingToken);
      setLease(res.lease);
      setLostLease(false);
    }
  }, [clientId, clientName, startHeartbeat]);

  const release = useCallback(() => {
    if (heldTokenRef.current !== null) {
      sendWs(wsRef.current!, {
        type: 'release-lease',
        clientId,
        fencingToken: heldTokenRef.current,
      });
      void apiRelease(clientId, heldTokenRef.current).catch(() => undefined);
      heldTokenRef.current = null;
      stopHeartbeat();
      setLease(null);
      setLostLease(false);
    }
  }, [clientId, stopHeartbeat]);

  const setFollowing = useCallback((v: boolean) => {
    setFollowMode(v);
    followRef.current = v;
    if (v && sharedCursor) {
      onSharedCursor(sharedCursor);
    }
  }, [sharedCursor, onSharedCursor]);

  const broadcastCursor = useCallback((cursor: ReplayCursor) => {
    if (heldTokenRef.current === null) return;
    cursorDirtyRef.current = false;
    sendWs(wsRef.current!, {
      type: 'advance-cursor',
      clientId,
      fencingToken: heldTokenRef.current,
      cursor,
    });
  }, [clientId]);

  const addNote = useCallback((text: string, snapshotId: string | null) => {
    const seq = noteSeqRef.current++;
    const note: SessionNote = {
      clientId,
      clientSeq: seq,
      authorName: clientName,
      text,
      snapshotId,
      createdAt: Date.now(),
    };
    setNotes((prev) => mergeNotes(prev, [note]));
    sendWs(wsRef.current!, { type: 'add-note', note });
  }, [clientId, clientName]);

  const followState: FollowState = useMemo(() => {
    if (lostLease) return 'lost-lease';
    if (!followMode) return 'independent';
    return 'following';
  }, [lostLease, followMode]);

  return {
    lease,
    isLeader,
    followState,
    notes,
    sharedCursor,
    fencingToken: isLeader ? heldTokenRef.current : null,
    clientId,
    clientName,
    leaderName,
    setClientName,
    acquire,
    release,
    setFollowing,
    broadcastCursor,
    addNote,
  };
}
