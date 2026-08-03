import { createHash } from "node:crypto";
import {
  buildView,
  diffViews,
  snapshotDigestInput,
  stableStringify,
  type IncidentSnapshotV1,
  type ReplayCursorV1,
  type VerifyReportV1,
} from "@replay/shared";
import type { ReplayStore } from "./store.js";

/**
 * 快照计算：digest 仅是 (账本, cursorA, cursorB) 的纯函数。
 * 相同账本与游标在任何进程、任何时刻都得到同一摘要。
 */
export function computeSnapshot(
  store: ReplayStore,
  cursorA: ReplayCursorV1,
  cursorB: ReplayCursorV1,
  label: string | null,
): IncidentSnapshotV1 {
  const entries = store.allEntries();
  const diff = diffViews(buildView(entries, cursorA), buildView(entries, cursorB));
  const digest = createHash("sha256")
    .update(stableStringify(snapshotDigestInput(cursorA, cursorB, diff)))
    .digest("hex");
  const head = store.head();
  return {
    contract: "incident-snapshot/1",
    id: `snap-${digest.slice(0, 16)}`,
    label,
    cursorA,
    cursorB,
    highWater: {
      ingestSequence: head.cursor.ingestSequence,
      eventTime: head.cursor.eventTime,
      totalEntries: head.totalEntries,
    },
    digest,
    createdAtMs: Date.now(),
    diff,
    notes: [],
  };
}

/** 复核：按当前账本与封存的游标重算摘要，比对封存值。 */
export function verifySnapshot(store: ReplayStore, snapshot: IncidentSnapshotV1): VerifyReportV1 {
  const entries = store.allEntries();
  const diff = diffViews(buildView(entries, snapshot.cursorA), buildView(entries, snapshot.cursorB));
  const recomputed = createHash("sha256")
    .update(stableStringify(snapshotDigestInput(snapshot.cursorA, snapshot.cursorB, diff)))
    .digest("hex");
  return {
    contract: "verify-report/1",
    id: snapshot.id,
    digest: snapshot.digest,
    recomputed,
    match: recomputed === snapshot.digest,
    checkedEntries: entries.length,
  };
}
