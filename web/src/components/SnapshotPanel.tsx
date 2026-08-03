import { useCallback, useEffect, useState } from "react";
import type {
  ChangeKind,
  IncidentSnapshotV1,
  SnapshotDetailV1,
  SnapshotListItemV1,
  VerifyReportV1,
} from "@replay/shared";
import {
  addSnapshotNote,
  formatTime,
  getSnapshotDetail,
  listSnapshots,
  sealSnapshot,
  verifySnapshot,
} from "../api.js";
import type { ReplayStore, Snapshot } from "../state.js";

export interface SnapshotPanelProps {
  open: boolean;
  snap: Snapshot;
  store: ReplayStore;
  onClose(): void;
  onSelectSpan(traceId: string, spanId: string): void;
}

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "新增",
  removed: "消失",
  changed: "变化",
};

function summaryText(s: SnapshotListItemV1["summary"]): string {
  return `新增 ${s.added} · 消失 ${s.removed} · 变化 ${s.changed}（状态翻转 ${s.statusFlips}）· 边 +${s.edgesAdded}/-${s.edgesRemoved}/~${s.edgesChanged} · 错误路径 ${s.errorPathTraces}`;
}

export function SnapshotPanel(props: SnapshotPanelProps): React.JSX.Element | null {
  const { snap, store } = props;
  const [items, setItems] = useState<SnapshotListItemV1[] | null>(null);
  const [detail, setDetail] = useState<SnapshotDetailV1 | null>(null);
  const [sealMsg, setSealMsg] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyReportV1 | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteAuthor, setNoteAuthor] = useState("值班");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listSnapshots();
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (props.open) {
      setError(null);
      void refresh();
    }
  }, [props.open, refresh]);

  const openDetail = useCallback(async (id: string): Promise<void> => {
    try {
      const d = await getSnapshotDetail(id);
      setDetail(d);
      setVerify(d.verify);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onSeal = async (): Promise<void> => {
    if (!snap.sealA || !snap.sealB) return;
    setSealMsg(null);
    try {
      const r = await sealSnapshot(snap.sealA, snap.sealB, null);
      setSealMsg(r.existing ? `已存在相同快照 ${r.snapshot.id}，未重复写入` : `已封存 ${r.snapshot.id}`);
      await refresh();
      const d = await getSnapshotDetail(r.snapshot.id);
      setDetail(d);
      setVerify(d.verify);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onVerify = async (id: string): Promise<void> => {
    try {
      setVerify(await verifySnapshot(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onAddNote = async (snapshot: IncidentSnapshotV1): Promise<void> => {
    if (!noteText.trim()) return;
    try {
      await addSnapshotNote(snapshot.id, noteAuthor, noteText);
      setNoteText("");
      await openDetail(snapshot.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!props.open) return null;
  const s = detail?.snapshot ?? null;

  return (
    <aside className="drawer" data-testid="snapshot-drawer">
      <div className="drawer-header">
        <span>事故快照（A/B 游标封存）</span>
        <button type="button" className="btn" data-testid="drawer-close" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <div className="drawer-section pin-row">
        <button type="button" className="btn" data-testid="seal-a-btn" onClick={() => store.setSealPoint("A")}>
          以当前游标设为 A
        </button>
        <button type="button" className="btn" data-testid="seal-b-btn" onClick={() => store.setSealPoint("B")}>
          以当前游标设为 B
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="seal-create-btn"
          disabled={!snap.sealA || !snap.sealB}
          onClick={() => void onSeal()}
        >
          封存快照
        </button>
      </div>
      <div className="drawer-section mono pin-readout" data-testid="seal-readout">
        <div>A：{snap.sealA ? `T=${formatTime(snap.sealA.eventTime)} ingest=${snap.sealA.ingestSequence}` : "未固定"}</div>
        <div>B：{snap.sealB ? `T=${formatTime(snap.sealB.eventTime)} ingest=${snap.sealB.ingestSequence}` : "未固定"}</div>
      </div>
      {sealMsg && (
        <div className="drawer-section seal-msg" data-testid="seal-msg">
          {sealMsg}
        </div>
      )}
      {error && <div className="drawer-section error-banner">{error}</div>}

      <div className="drawer-section">
        <div className="section-title">已封存快照</div>
        {items === null && <div className="empty">加载中…</div>}
        {items !== null && items.length === 0 && <div className="empty">尚无快照：固定 A、B 两个游标后封存</div>}
        {items?.map((it) => (
          <button
            type="button"
            key={it.id}
            className={`snapshot-item${s?.id === it.id ? " selected" : ""}`}
            data-testid={`snapshot-item-${it.id}`}
            onClick={() => void openDetail(it.id)}
          >
            <span className="mono snapshot-id">{it.label ?? it.id}</span>
            <span className="snapshot-summary">{summaryText(it.summary)}</span>
            <span className="snapshot-meta mono">
              {new Date(it.createdAtMs).toISOString().slice(0, 19)}Z · 备注 {it.noteCount}
            </span>
          </button>
        ))}
      </div>

      {s && (
        <div className="drawer-section" data-testid="snapshot-detail">
          <div className="section-title">快照详情 {s.label ? `· ${s.label}` : ""}</div>
          <div className="detail-grid">
            <span>digest</span>
            <span className="mono" data-testid="snapshot-digest">
              {s.digest}
            </span>
            <span>游标 A</span>
            <span className="mono">
              T={formatTime(s.cursorA.eventTime)} ingest={s.cursorA.ingestSequence}
            </span>
            <span>游标 B</span>
            <span className="mono">
              T={formatTime(s.cursorB.eventTime)} ingest={s.cursorB.ingestSequence}
            </span>
            <span>封存高水位</span>
            <span className="mono" data-testid="snapshot-highwater">
              ingest={s.highWater.ingestSequence} · entries={s.highWater.totalEntries} · T=
              {formatTime(s.highWater.eventTime)}
            </span>
          </div>
          <div className="verify-row">
            <button type="button" className="btn" data-testid="verify-btn" onClick={() => void onVerify(s.id)}>
              按当前账本复核摘要
            </button>
            {verify && (
              <span
                className={`chip ${verify.match ? "conn-live" : "status-error"}`}
                data-testid="verify-result"
              >
                {verify.match ? `一致（复核覆盖 ${verify.checkedEntries} 条账本）` : "失配！"}
              </span>
            )}
          </div>

          <div className="section-title" data-testid="diff-summary">
            {summaryText(s.diff.summary)}
          </div>

          {s.diff.spanChanges.length > 0 && (
            <div className="section-title">span 变化</div>
          )}
          {s.diff.spanChanges.map((c) => (
            <button
              type="button"
              key={`${c.traceId}/${c.spanId}`}
              className="change-row"
              data-testid={`span-change-${c.spanId}`}
              onClick={() => props.onSelectSpan(c.traceId, c.spanId)}
            >
              <span className={`chip kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <span className="span-service">{c.service}</span>
              <span className="span-op">{c.operation}</span>
              <span className="mono change-spanid">{c.spanId}</span>
              <span className="change-text">{c.changes.join("；")}</span>
            </button>
          ))}

          {s.diff.edgeChanges.length > 0 && <div className="section-title">服务调用边变化</div>}
          {s.diff.edgeChanges.map((c) => (
            <div key={`${c.fromService} ${c.toService}`} className="change-row static">
              <span className={`chip kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <span className="mono">
                {c.fromService} → {c.toService}
              </span>
              <span className="change-text">{c.changes.join("；")}</span>
            </div>
          ))}

          {s.diff.errorPathChanges.length > 0 && <div className="section-title">关键路径（错误传播）变化</div>}
          {s.diff.errorPathChanges.map((c) => (
            <div key={c.traceId} className="change-row static">
              <span className="mono">{c.traceId}</span>
              <span className="change-text">
                {c.gainedSpanIds.length > 0 && `新增错误：${c.gainedSpanIds.join(", ")}`}
                {c.gainedSpanIds.length > 0 && c.lostSpanIds.length > 0 && "；"}
                {c.lostSpanIds.length > 0 && `不再是错误：${c.lostSpanIds.join(", ")}`}
              </span>
            </div>
          ))}

          <div className="section-title">调查备注</div>
          {s.notes.length === 0 && <div className="empty">暂无备注</div>}
          {s.notes.map((n) => (
            <div key={n.noteId} className="note-item" data-testid={`note-item-${n.noteId}`}>
              <span className="mono note-meta">
                {n.author} · {new Date(n.createdAtMs).toISOString().slice(0, 19)}Z
              </span>
              <div>{n.text}</div>
            </div>
          ))}
          <div className="note-form">
            <input
              className="input note-author"
              data-testid="note-author"
              value={noteAuthor}
              onChange={(e) => setNoteAuthor(e.target.value)}
              placeholder="署名"
            />
            <input
              className="input"
              data-testid="note-input"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="记录调查结论…"
            />
            <button
              type="button"
              className="btn"
              data-testid="note-submit"
              disabled={!noteText.trim()}
              onClick={() => void onAddNote(s)}
            >
              追加
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
