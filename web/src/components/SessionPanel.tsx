import { useEffect, useState } from "react";
import { formatTime } from "../api.js";
import { collabRoleLabel, useCollab, type CollabClient } from "../session.js";
import type { Snapshot } from "../state.js";

export interface SessionPanelProps {
  collab: CollabClient;
  replaySnap: Snapshot;
  onOpenSnapshot(id: string): void;
}

/** 跨班协作面板：会话列表/锚点发起、租约与 fencing、共同游标、确定性归并备注。 */
export function SessionPanel(props: SessionPanelProps): React.JSX.Element {
  const { collab, replaySnap } = props;
  const cs = useCollab(collab);
  const [ttlSec, setTtlSec] = useState(15);
  const [noteText, setNoteText] = useState("");
  const [snapshots, setSnapshots] = useState<Array<{ id: string; label: string | null; digest: string }> | null>(null);

  useEffect(() => {
    void collab.refreshSessions();
    void fetch("/api/snapshots")
      .then((r) => r.json())
      .then((j: { items: Array<{ id: string; label: string | null; digest: string }> }) => setSnapshots(j.items))
      .catch(() => setSnapshots([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = cs.session;
  const leaseValid =
    session?.lease != null && session.lease.expiresAtMs > (session.serverTimeMs ?? 0);

  return (
    <div className="drawer-section collab" data-testid="collab-panel">
      <div className="section-title">跨班协作会话</div>
      <div className="identity-row">
        <input
          className="input identity-input"
          data-testid="session-name-input"
          value={cs.clientName}
          onChange={(e) => collab.setName(e.target.value)}
          placeholder="班组名"
        />
        <span className="mono identity-id" title={cs.clientId}>
          {cs.clientId.slice(0, 10)}…
        </span>
      </div>
      {cs.error && (
        <div className="error-banner" data-testid="collab-error">
          {cs.error}
        </div>
      )}

      {!session && (
        <>
          <div className="section-title">以封存快照为锚点发起会话</div>
          {snapshots === null && <div className="empty">加载中…</div>}
          {snapshots?.length === 0 && <div className="empty">尚无快照，请先在上方封存</div>}
          {snapshots?.map((s) => (
            <div key={s.id} className="session-line">
              <span className="mono session-line-id">{s.label ?? s.id}</span>
              <button
                type="button"
                className="btn"
                data-testid={`session-create-${s.id}`}
                onClick={() => void collab.createFromSnapshot(s.id)}
              >
                发起会话
              </button>
            </div>
          ))}
          <div className="section-title">加入既有会话</div>
          {cs.sessions === null && <div className="empty">加载中…</div>}
          {cs.sessions?.length === 0 && <div className="empty">暂无会话</div>}
          {cs.sessions?.map((s) => (
            <div key={s.sessionId} className="session-line">
              <span className="mono session-line-id">
                {s.label ?? s.sessionId}（{s.createdBy}）
                {s.leaseHolderName ? ` · 负责人 ${s.leaseHolderName}` : ""}
              </span>
              <button
                type="button"
                className="btn"
                data-testid={`session-join-${s.sessionId}`}
                onClick={() => void collab.join(s.sessionId)}
              >
                加入
              </button>
            </div>
          ))}
        </>
      )}

      {session && (
        <div data-testid="session-panel">
          <div className="session-head">
            <span className="mono session-anchor" data-testid="session-anchor">
              锚点 {session.anchorSnapshotId} · digest {session.anchorDigest.slice(0, 12)}…
            </span>
            <button type="button" className="btn" data-testid="session-leave" onClick={() => collab.leave()}>
              离开会话
            </button>
          </div>

          <div className="lease-box">
            {leaseValid && session.lease ? (
              <span className="mono" data-testid="lease-info">
                负责人 {session.lease.holderName} · fencing #
                <span data-testid="fencing-token">{session.lease.fencingToken}</span> · 剩余{" "}
                {Math.max(0, Math.round((session.lease.expiresAtMs - session.serverTimeMs) / 1000))}s
              </span>
            ) : (
              <span className="mono lease-none" data-testid="lease-info">
                当前无人持有有效租约
              </span>
            )}
            <div className="lease-actions">
              <input
                className="input ttl-input"
                data-testid="lease-ttl"
                type="number"
                min={3}
                max={120}
                value={ttlSec}
                onChange={(e) => setTtlSec(Number(e.target.value))}
                title="租约秒数"
              />
              <button
                type="button"
                className="btn"
                data-testid="lease-acquire"
                onClick={() => void collab.acquireLease(ttlSec * 1000)}
              >
                {cs.role === "stale" ? "重新获取租约" : "获取租约"}
              </button>
              {cs.role === "owner" && (
                <button type="button" className="btn" data-testid="lease-release" onClick={() => void collab.releaseLease()}>
                  释放
                </button>
              )}
            </div>
          </div>

          <div className="shared-cursor-box">
            <span className="mono" data-testid="shared-cursor-readout">
              共同游标 T={formatTime(session.sharedCursor.eventTime)} ingest={session.sharedCursor.ingestSequence}
            </span>
            <div className="lease-actions">
              <button
                type="button"
                className="btn"
                data-testid="push-cursor-btn"
                disabled={cs.role !== "owner"}
                title={cs.role === "owner" ? "把本地当前游标推进为共同游标" : "仅负责人可推进"}
                onClick={() => void collab.pushSharedCursor(replaySnap.cursor)}
              >
                推进共同游标到当前游标
              </button>
              <button
                type="button"
                className="btn"
                data-testid="session-seal-btn"
                disabled={cs.role !== "owner" || !replaySnap.sealA || !replaySnap.sealB}
                title="用上方固定的 A/B 游标在会话内封存"
                onClick={() => void collab.sealIntoSession(replaySnap, "会话快照")}
              >
                把 A/B 封存进会话
              </button>
            </div>
            {cs.role === "follower" && (
              <label className="check">
                <input
                  type="checkbox"
                  data-testid="follow-toggle"
                  checked={cs.follow}
                  onChange={(e) => collab.setFollow(e.target.checked)}
                />
                跟随共同游标
              </label>
            )}
            {cs.role === "stale" && (
              <div className="stale-banner" data-testid="stale-banner">
                你已失去租约：fencing token 已失效，无法推进共同游标或封存。
              </div>
            )}
          </div>

          <div className="section-title">参与者（{session.participants.length}）</div>
          <div className="participants" data-testid="session-participants">
            {session.participants.map((p) => (
              <span key={p.clientId} className={`chip${p.clientId === cs.clientId ? " mode-live" : ""}`}>
                {p.name}
                {session.lease?.holderId === p.clientId && leaseValid ? " ★" : ""}
              </span>
            ))}
          </div>

          <div className="section-title">
            会话备注（确定性归并 · digest <span className="mono" data-testid="merge-digest">{session.mergeDigest.slice(0, 10)}</span>）
          </div>
          <div className="session-notes" data-testid="session-notes">
            {session.notes.length === 0 && <div className="empty">暂无备注</div>}
            {session.notes.map((n) => (
              <div key={n.noteId} className="note-item" data-testid={`session-note-${n.noteId}`}>
                <span className="mono note-meta">
                  {n.author} · {new Date(n.createdAtMs).toISOString().slice(11, 19)}
                </span>
                <div>{n.text}</div>
              </div>
            ))}
          </div>
          <div className="note-form">
            <input
              className="input"
              data-testid="session-note-input"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="写下调查进展…"
            />
            <button
              type="button"
              className="btn"
              data-testid="session-note-submit"
              disabled={!noteText.trim()}
              onClick={() => {
                void collab.postNote(noteText);
                setNoteText("");
              }}
            >
              发送
            </button>
          </div>

          <div className="section-title">会话内封存（{session.snapshotIds.length}）</div>
          {session.snapshotIds.map((id) => (
            <div key={id} className="session-line" data-testid={`session-snapshot-${id}`}>
              <span className="mono session-line-id">{id}</span>
              <button type="button" className="btn" onClick={() => props.onOpenSnapshot(id)}>
                打开
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
