import { useSyncExternalStore } from "react";
import type {
  GateErrorV1,
  InvestigationSessionV1,
  ReplayCursorV1,
  SealResponseV1,
  SessionListV1,
  SessionListItemV1,
} from "@replay/shared";
import type { LiveConnection } from "./live.js";
import type { ReplayStore, Snapshot as ReplaySnapshot } from "./state.js";

export type CollabRole = "independent" | "owner" | "follower" | "stale";

export interface CollabSnapshot {
  role: CollabRole;
  session: InvestigationSessionV1 | null;
  sessions: SessionListItemV1[] | null;
  clientId: string;
  clientName: string;
  fencingToken: number | null;
  follow: boolean;
  error: string | null;
}

const ROLE_LABELS: Record<CollabRole, string> = {
  independent: "独立查看",
  owner: "负责人（持有租约）",
  follower: "跟随负责人",
  stale: "已失去租约",
};

export function collabRoleLabel(role: CollabRole): string {
  return ROLE_LABELS[role];
}

function newClientId(): string {
  return `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

async function req<T>(path: string, method: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

/**
 * 协作客户端：会话加入/租约心跳/共同游标跟随/确定性备注。
 * 三态区分：跟随负责人（他人持有效租约）、独立查看（无租约或不在会话）、
 * 已失去租约（曾持租但 token 已被判 stale）。
 */
export class CollabClient {
  private readonly listeners = new Set<() => void>();
  private scheduled = false;

  readonly clientId: string;
  private clientName: string;
  private session: InvestigationSessionV1 | null = null;
  private sessions: SessionListItemV1[] | null = null;
  private fencingToken: number | null = null;
  private lostLease = false;
  private follow = true;
  private error: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private snap: CollabSnapshot;

  constructor(
    private readonly replay: ReplayStore,
    private readonly live: LiveConnection,
  ) {
    this.clientId = localStorage.getItem("replay.clientId") ?? newClientId();
    localStorage.setItem("replay.clientId", this.clientId);
    this.clientName = localStorage.getItem("replay.clientName") ?? "班组-A";
    live.onSessionState = (state) => this.onSessionState(state);
    this.snap = this.buildSnap();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): CollabSnapshot => this.snap;

  private buildSnap(): CollabSnapshot {
    return {
      role: this.computeRole(),
      session: this.session,
      sessions: this.sessions,
      clientId: this.clientId,
      clientName: this.clientName,
      fencingToken: this.fencingToken,
      follow: this.follow,
      error: this.error,
    };
  }

  private computeRole(): CollabRole {
    if (!this.session) return "independent";
    const lease = this.session.lease;
    const valid = lease !== null && lease.expiresAtMs > this.session.serverTimeMs;
    // 租约持有者是自己：永不判为跟随（授租广播可能先于本地 token 写入到达）
    if (valid && lease.holderId === this.clientId) {
      if (lease.fencingToken === this.fencingToken) return "owner";
      return this.fencingToken === null ? "independent" : "stale";
    }
    if (this.lostLease) return "stale";
    // 本地仍持有 token，但服务端租约已易主或已过期 → 已失去租约
    if (this.fencingToken !== null && !valid) return "stale";
    if (valid) return "follower";
    return "independent";
  }

  private changed(): void {
    this.snap = this.buildSnap();
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      for (const fn of this.listeners) fn();
    }, 30);
  }

  private onSessionState(state: InvestigationSessionV1): void {
    if (this.session?.sessionId !== state.sessionId) return;
    this.session = state;
    if (this.computeRole() === "follower" && this.follow) {
      this.replay.applyExternalCursor(state.sharedCursor);
    }
    this.changed();
  }

  setName(name: string): void {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    this.clientName = trimmed;
    localStorage.setItem("replay.clientName", trimmed);
    this.changed();
  }

  setFollow(follow: boolean): void {
    this.follow = follow;
    if (follow && this.session && this.computeRole() === "follower") {
      this.replay.applyExternalCursor(this.session.sharedCursor);
    }
    this.changed();
  }

  async refreshSessions(): Promise<void> {
    try {
      const { json } = await req<SessionListV1>("/api/sessions", "GET");
      this.sessions = json.items;
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.changed();
  }

  async createFromSnapshot(snapshotId: string): Promise<void> {
    const { status, json } = await req<InvestigationSessionV1>("/api/sessions", "POST", {
      snapshotId,
      clientId: this.clientId,
      name: this.clientName,
      label: null,
    });
    if (status !== 201) {
      this.error = `发起会话失败：${status}`;
      this.changed();
      return;
    }
    this.adoptSession(json);
  }

  async join(sessionId: string): Promise<void> {
    const { status, json } = await req<InvestigationSessionV1>(
      `/api/sessions/${encodeURIComponent(sessionId)}/join`,
      "POST",
      { clientId: this.clientId, name: this.clientName },
    );
    if (status !== 200) {
      this.error = `加入会话失败：${status}`;
      this.changed();
      return;
    }
    this.adoptSession(json);
  }

  private adoptSession(state: InvestigationSessionV1): void {
    this.leaveInternal();
    this.session = state;
    this.live.setSession(state.sessionId);
    this.error = null;
    this.changed();
  }

  leave(): void {
    this.leaveInternal();
    this.changed();
  }

  private leaveInternal(): void {
    this.stopHeartbeat();
    this.fencingToken = null;
    this.lostLease = false;
    this.session = null;
    this.live.setSession(null);
  }

  async acquireLease(ttlMs: number): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;
    const { status, json } = await req<InvestigationSessionV1 | GateErrorV1>(
      `/api/sessions/${encodeURIComponent(sessionId)}/lease`,
      "POST",
      { clientId: this.clientId, name: this.clientName, ttlMs },
    );
    if (status === 200) {
      const state = json as InvestigationSessionV1;
      this.session = state;
      this.fencingToken = state.lease?.fencingToken ?? null;
      this.lostLease = false;
      this.error = null;
      this.startHeartbeat(ttlMs);
    } else {
      const err = json as GateErrorV1;
      this.error = err.error === "lease-held" ? `租约由 ${err.lease?.holderName ?? "他人"} 持有` : err.error;
    }
    this.changed();
  }

  async releaseLease(): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId || this.fencingToken === null) return;
    await req(
      `/api/sessions/${encodeURIComponent(sessionId)}/lease/release`,
      "POST",
      { clientId: this.clientId, fencingToken: this.fencingToken },
    );
    this.stopHeartbeat();
    this.fencingToken = null;
    this.changed();
  }

  private startHeartbeat(ttlMs: number): void {
    this.stopHeartbeat();
    const interval = Math.max(1_000, Math.floor(ttlMs / 3));
    this.heartbeat = setInterval(() => {
      void this.renew(ttlMs);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private async renew(ttlMs: number): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId || this.fencingToken === null) return;
    const { status } = await req(
      `/api/sessions/${encodeURIComponent(sessionId)}/lease/renew`,
      "POST",
      { clientId: this.clientId, fencingToken: this.fencingToken, ttlMs },
    );
    if (status === 409) {
      // 租约过期或已被接管：进入“已失去租约”态， gated 操作全部被拒
      this.stopHeartbeat();
      this.lostLease = true;
      this.error = "租约已失效（fencing token 过期），可重新获取";
      this.changed();
    }
  }

  /** 推进共同游标到本地当前游标（需持有有效租约）。 */
  async pushSharedCursor(cursor: ReplayCursorV1): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId || this.fencingToken === null) return;
    const { status, json } = await req<InvestigationSessionV1 | GateErrorV1>(
      `/api/sessions/${encodeURIComponent(sessionId)}/cursor`,
      "POST",
      { clientId: this.clientId, fencingToken: this.fencingToken, cursor },
    );
    if (status === 200) {
      this.session = json as InvestigationSessionV1;
      this.error = null;
    } else {
      this.error = `推进被拒：${(json as GateErrorV1).error}`;
      if ((json as GateErrorV1).error === "stale-fencing-token") this.lostLease = true;
    }
    this.changed();
  }

  /** 会话内封存（需持有有效租约），复用全局 A/B 游标。 */
  async sealIntoSession(replaySnap: ReplaySnapshot, label: string | null): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId || this.fencingToken === null || !replaySnap.sealA || !replaySnap.sealB) return;
    const { status, json } = await req<SealResponseV1 | GateErrorV1>(
      `/api/sessions/${encodeURIComponent(sessionId)}/seal`,
      "POST",
      {
        clientId: this.clientId,
        fencingToken: this.fencingToken,
        cursorA: replaySnap.sealA,
        cursorB: replaySnap.sealB,
        label,
      },
    );
    if (status === 200 || status === 201) {
      this.error = null;
    } else {
      this.error = `封存被拒：${(json as GateErrorV1).error}`;
      if ((json as GateErrorV1).error === "stale-fencing-token") this.lostLease = true;
    }
    this.changed();
  }

  async postNote(text: string): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId || !text.trim()) return;
    const noteId = `n-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const { status } = await req(
      `/api/sessions/${encodeURIComponent(sessionId)}/notes`,
      "POST",
      {
        clientId: this.clientId,
        author: this.clientName,
        text: text.trim(),
        noteId,
        createdAtMs: Date.now(),
      },
    );
    if (status !== 201) this.error = `备注失败：${status}`;
    this.changed();
  }
}

export function useCollab(collab: CollabClient): CollabSnapshot {
  return useSyncExternalStore(collab.subscribe, collab.getSnapshot, collab.getSnapshot);
}
