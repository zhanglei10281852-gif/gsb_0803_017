import type { ReplayViewV1 } from "@replay/shared";
import { formatTime } from "../api.js";
import { collabRoleLabel, type CollabRole } from "../session.js";
import type { Snapshot } from "../state.js";

export interface TopBarProps {
  snap: Snapshot;
  view: ReplayViewV1;
  collabRole: CollabRole;
  onToggleSnapshots(): void;
}

const CONNECTION_LABEL: Record<Snapshot["connection"], string> = {
  connecting: "连接中",
  live: "实时连接",
  reconnecting: "重连中",
};

export function TopBar({ snap, view, collabRole, onToggleSnapshots }: TopBarProps): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar-title">链路事故回放平台</div>
      <span className={`chip conn-${snap.connection}`} data-testid="status-chip">
        {CONNECTION_LABEL[snap.connection]}
      </span>
      <span className={`chip mode-${snap.mode}`} data-testid="mode-chip">
        {snap.mode === "live" ? "实时跟随" : "暂停回放"}
      </span>
      <span className={`chip collab-${collabRole}`} data-testid="collab-role">
        {collabRoleLabel(collabRole)}
      </span>
      <button type="button" className="btn" data-testid="snapshot-toggle" onClick={onToggleSnapshots}>
        快照对比
      </button>
      {(snap.sealA || snap.sealB) && (
        <span className="mono seal-indicator" data-testid="seal-indicator">
          {snap.sealA ? `A:N=${snap.sealA.ingestSequence} ` : ""}
          {snap.sealB ? `B:N=${snap.sealB.ingestSequence}` : ""}
        </span>
      )}
      <span className="topbar-stat" data-testid="totals">
        账本 {snap.totalEntries} 条 · 服务 {view.services.length} 个 · 游标处可见 span {view.totals.visibleSpans}（错误 {view.totals.errorSpans}）
      </span>
      <span className="topbar-cursor" data-testid="head-readout">
        head T={formatTime(snap.head.eventTime)} ingest={snap.head.ingestSequence}
      </span>
    </header>
  );
}
