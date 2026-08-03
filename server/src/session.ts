import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  stableStringify,
  type IncidentSnapshotV1,
  type InvestigationSessionV1,
  type LeaseV1,
  type ReplayCursorV1,
  type SessionListItemV1,
} from "@replay/shared";
import { computeSnapshot } from "./snapshot.js";
import type { ReplayStore } from "./store.js";

export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; lease: LeaseV1 | null };

function gateError(status: number, error: string, lease: LeaseV1 | null): SessionResult<never> {
  return { ok: false, status, error, lease };
}

/**
 * 会话服务：租约 + fencing token 门控共同游标与会话内封存；
 * 备注全员可写、按 (createdAtMs, clientId, noteId) 确定性归并。
 * 所有状态持久化于 SQLite，服务重启后继续成立。
 */
export class SessionService {
  constructor(
    private readonly store: ReplayStore,
    private readonly emitter: EventEmitter,
  ) {}

  private buildState(sessionId: string): InvestigationSessionV1 | null {
    const row = this.store.getSessionRow(sessionId);
    if (!row) return null;
    const leaseRow = this.store.getLease(sessionId);
    const lease: LeaseV1 | null = leaseRow
      ? {
          holderId: leaseRow.holder_id,
          holderName: leaseRow.holder_name,
          fencingToken: leaseRow.fencing_token,
          acquiredAtMs: leaseRow.acquired_at_ms,
          expiresAtMs: leaseRow.expires_at_ms,
          ttlMs: leaseRow.ttl_ms,
        }
      : null;
    const notes = this.store.listSessionNotes(sessionId);
    const mergeDigest = createHash("sha256")
      .update(stableStringify(notes.map((n) => n.noteId)))
      .digest("hex");
    return {
      contract: "investigation-session/1",
      sessionId,
      anchorSnapshotId: row.anchor_snapshot_id,
      anchorDigest: row.anchor_digest,
      label: row.label,
      createdAtMs: row.created_at_ms,
      createdBy: row.created_by,
      sharedCursor: JSON.parse(row.shared_cursor) as ReplayCursorV1,
      lease,
      participants: this.store.listParticipants(sessionId),
      notes,
      mergeDigest,
      snapshotIds: this.store.listSessionSnapshotIds(sessionId),
      serverTimeMs: Date.now(),
    };
  }

  /** 状态变更后广播给所有订阅该会话的 WS 连接。 */
  private publish(sessionId: string): InvestigationSessionV1 | null {
    const state = this.buildState(sessionId);
    if (state) this.emitter.emit("session", state);
    return state;
  }

  getSession(sessionId: string): InvestigationSessionV1 | null {
    return this.buildState(sessionId);
  }

  listSessions(): SessionListItemV1[] {
    const now = Date.now();
    return this.store.listSessionRows().map((r) => {
      const lease = this.store.getLease(r.session_id);
      return {
        contract: "session-item/1",
        sessionId: r.session_id,
        anchorSnapshotId: r.anchor_snapshot_id,
        anchorDigest: r.anchor_digest,
        label: r.label,
        createdAtMs: r.created_at_ms,
        createdBy: r.created_by,
        leaseHolderName: lease && lease.expires_at_ms > now ? lease.holder_name : null,
        noteCount: this.store.countSessionNotes(r.session_id),
      };
    });
  }

  createSession(input: {
    snapshotId: string;
    clientId: string;
    name: string;
    label: string | null;
  }): SessionResult<InvestigationSessionV1> {
    const anchor = this.store.getSnapshot(input.snapshotId);
    if (!anchor) return gateError(404, "锚点快照不存在", null);
    const sessionId = `ses-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    // 共同游标从锚点快照的 B 游标起步
    this.store.createSessionRow({
      sessionId,
      anchorSnapshotId: anchor.id,
      anchorDigest: anchor.digest,
      label: input.label ?? anchor.label,
      createdAtMs: now,
      createdBy: input.name,
      sharedCursor: anchor.cursorB,
    });
    this.store.upsertParticipant(sessionId, input.clientId, input.name, now);
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话创建失败", null);
    return { ok: true, value: state };
  }

  join(sessionId: string, clientId: string, name: string): SessionResult<InvestigationSessionV1> {
    if (!this.store.getSessionRow(sessionId)) return gateError(404, "会话不存在", null);
    this.store.upsertParticipant(sessionId, clientId, name, Date.now());
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话状态异常", null);
    return { ok: true, value: state };
  }

  acquireLease(
    sessionId: string,
    clientId: string,
    name: string,
    ttlMs: number,
  ): SessionResult<InvestigationSessionV1> {
    if (!this.store.getSessionRow(sessionId)) return gateError(404, "会话不存在", null);
    const now = Date.now();
    const current = this.store.getLease(sessionId);
    if (current && current.expires_at_ms > now && current.holder_id !== clientId) {
      return gateError(409, "lease-held", this.leaseOf(current));
    }
    // 同一持有者重新获取也走新 token（等价于续租强化）
    const fencingToken = this.store.nextFencingToken(sessionId);
    this.store.setLease(sessionId, {
      holderId: clientId,
      holderName: name,
      fencingToken,
      acquiredAtMs: now,
      expiresAtMs: now + ttlMs,
      ttlMs,
    });
    this.store.upsertParticipant(sessionId, clientId, name, now);
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话状态异常", null);
    return { ok: true, value: state };
  }

  renewLease(
    sessionId: string,
    clientId: string,
    fencingToken: number,
    ttlMs: number,
  ): SessionResult<InvestigationSessionV1> {
    const gate = this.gate(sessionId, clientId, fencingToken);
    if (!gate.ok) return gate;
    const now = Date.now();
    this.store.setLease(sessionId, {
      holderId: gate.value.holderId,
      holderName: gate.value.holderName,
      fencingToken: gate.value.fencingToken,
      acquiredAtMs: gate.value.acquiredAtMs,
      expiresAtMs: now + ttlMs,
      ttlMs,
    });
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话状态异常", null);
    return { ok: true, value: state };
  }

  releaseLease(sessionId: string, clientId: string, fencingToken: number): SessionResult<InvestigationSessionV1> {
    if (!this.store.getSessionRow(sessionId)) return gateError(404, "会话不存在", null);
    const current = this.store.getLease(sessionId);
    if (current && current.holder_id === clientId && current.fencing_token === fencingToken) {
      this.store.clearLease(sessionId);
    }
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话状态异常", null);
    return { ok: true, value: state };
  }

  /** 门控：仅持有有效租约且 fencing token 匹配的一方可推进共同游标/封存。 */
  private gate(
    sessionId: string,
    clientId: string,
    fencingToken: number,
  ): SessionResult<LeaseV1> {
    const row = this.store.getSessionRow(sessionId);
    if (!row) return gateError(404, "会话不存在", null);
    const current = this.store.getLease(sessionId);
    const now = Date.now();
    if (!current || current.expires_at_ms <= now) {
      return gateError(409, "no-valid-lease", current ? this.leaseOf(current) : null);
    }
    if (current.holder_id !== clientId || current.fencing_token !== fencingToken) {
      // 旧客户端的过期 token 即使晚到也不能覆盖新负责人
      return gateError(409, "stale-fencing-token", this.leaseOf(current));
    }
    return { ok: true, value: this.leaseOf(current) };
  }

  private leaseOf(row: {
    holder_id: string;
    holder_name: string;
    fencing_token: number;
    acquired_at_ms: number;
    expires_at_ms: number;
    ttl_ms: number;
  }): LeaseV1 {
    return {
      holderId: row.holder_id,
      holderName: row.holder_name,
      fencingToken: row.fencing_token,
      acquiredAtMs: row.acquired_at_ms,
      expiresAtMs: row.expires_at_ms,
      ttlMs: row.ttl_ms,
    };
  }

  pushCursor(
    sessionId: string,
    clientId: string,
    fencingToken: number,
    cursor: ReplayCursorV1,
  ): SessionResult<InvestigationSessionV1> {
    const gate = this.gate(sessionId, clientId, fencingToken);
    if (!gate.ok) return gate;
    this.store.updateSharedCursor(sessionId, cursor);
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话状态异常", null);
    return { ok: true, value: state };
  }

  sealSnapshot(
    sessionId: string,
    clientId: string,
    fencingToken: number,
    cursorA: ReplayCursorV1,
    cursorB: ReplayCursorV1,
    label: string | null,
  ): SessionResult<{ snapshot: IncidentSnapshotV1; existing: boolean }> {
    const gate = this.gate(sessionId, clientId, fencingToken);
    if (!gate.ok) return gate;
    const computed = computeSnapshot(this.store, cursorA, cursorB, label);
    const { existing } = this.store.saveSnapshot(computed);
    const stored = this.store.getSnapshot(computed.id) ?? computed;
    this.store.linkSessionSnapshot(sessionId, stored.id, Date.now());
    this.publish(sessionId);
    return { ok: true, value: { snapshot: stored, existing } };
  }

  addNote(
    sessionId: string,
    note: { clientId: string; author: string; text: string; noteId: string; createdAtMs: number },
  ): SessionResult<InvestigationSessionV1> {
    if (!this.store.getSessionRow(sessionId)) return gateError(404, "会话不存在", null);
    this.store.insertSessionNote(sessionId, note);
    this.store.upsertParticipant(sessionId, note.clientId, note.author, Date.now());
    const state = this.publish(sessionId);
    if (!state) return gateError(500, "会话状态异常", null);
    return { ok: true, value: state };
  }
}
