import type { LedgerEntryV1, ReplayCursorV1 } from "./contract.js";

export function cursorOf(eventTime: number, ingestSequence: number): ReplayCursorV1 {
  return { contract: "replay-cursor/1", eventTime, ingestSequence };
}

export const ZERO_CURSOR: ReplayCursorV1 = cursorOf(0, 0);

/** 条目在游标处可见 ⇔ 两个坐标都不越界。 */
export function isVisibleAt(entry: LedgerEntryV1, cursor: ReplayCursorV1): boolean {
  return (
    entry.ingestSequence <= cursor.ingestSequence &&
    entry.event.eventTime <= cursor.eventTime
  );
}

export function formatCursor(cursor: ReplayCursorV1): string {
  return `T=${cursor.eventTime} ingest=${cursor.ingestSequence}`;
}
