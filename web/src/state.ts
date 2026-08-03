import { useSyncExternalStore } from "react";
import { cursorOf, ZERO_CURSOR, type LedgerEntryV1, type ReplayCursorV1 } from "@replay/shared";

export type ConnectionState = "connecting" | "live" | "reconnecting";
export type Mode = "live" | "paused";

export interface Selection {
  traceId: string;
  spanId: string;
}

export interface Snapshot {
  version: number;
  connection: ConnectionState;
  mode: Mode;
  cursor: ReplayCursorV1;
  head: ReplayCursorV1;
  pinnedIngest: number;
  totalEntries: number;
  selection: Selection | null;
  serviceFilter: string | null;
  domainMin: number;
  domainMax: number;
}

/**
 * 浏览器端账本副本 + 回放游标。
 * 暂停时游标 = (拖动选择的 eventTime, 暂停瞬间的 ingestSequence)，
 * 两个坐标都可显式调整，保证同一游标永远渲染同一视图。
 */
export class ReplayStore {
  private entries: LedgerEntryV1[] = [];
  private readonly seqSet = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private scheduled = false;

  private connection: ConnectionState = "connecting";
  private mode: Mode = "live";
  private cursor: ReplayCursorV1 = ZERO_CURSOR;
  private head: ReplayCursorV1 = ZERO_CURSOR;
  private pinnedIngest = 0;
  private totalEntries = 0;
  private selection: Selection | null = null;
  private serviceFilter: string | null = null;
  private domainMin = 0;
  private domainMax = 0;
  private version = 0;
  private snap: Snapshot = this.buildSnap();

  private buildSnap(): Snapshot {
    return {
      version: this.version,
      connection: this.connection,
      mode: this.mode,
      cursor: this.cursor,
      head: this.head,
      pinnedIngest: this.pinnedIngest,
      totalEntries: this.totalEntries,
      selection: this.selection,
      serviceFilter: this.serviceFilter,
      domainMin: this.domainMin,
      domainMax: this.domainMax,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): Snapshot => this.snap;

  getEntries(): readonly LedgerEntryV1[] {
    return this.entries;
  }

  get lastSeq(): number {
    const last = this.entries[this.entries.length - 1];
    return last ? last.ingestSequence : 0;
  }

  private changed(): void {
    this.version += 1;
    this.snap = this.buildSnap();
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      for (const fn of this.listeners) fn();
    }, 50);
  }

  applyEntry(entry: LedgerEntryV1): void {
    if (this.seqSet.has(entry.ingestSequence)) return;
    this.seqSet.add(entry.ingestSequence);
    this.entries.push(entry);
    const t = entry.event.eventTime;
    this.head = cursorOf(
      Math.max(t, this.head.eventTime),
      Math.max(entry.ingestSequence, this.head.ingestSequence),
    );
    if (this.entries.length === 1) this.domainMin = t;
    this.domainMin = Math.min(this.domainMin, t);
    this.domainMax = Math.max(this.domainMax, t);
    if (this.mode === "live") this.cursor = this.head;
    this.changed();
  }

  applyHello(head: ReplayCursorV1, totalEntries: number): void {
    this.totalEntries = totalEntries;
    if (this.entries.length === 0) {
      this.head = head;
      if (this.mode === "live") this.cursor = head;
    }
    this.changed();
  }

  setConnection(c: ConnectionState): void {
    if (c !== this.connection) {
      this.connection = c;
      this.changed();
    }
  }

  pause(): void {
    if (this.mode !== "live") return;
    this.mode = "paused";
    this.pinnedIngest = this.head.ingestSequence;
    this.cursor = cursorOf(this.head.eventTime, this.pinnedIngest);
    this.changed();
  }

  resumeLive(): void {
    if (this.mode === "live") return;
    this.mode = "live";
    this.cursor = this.head;
    this.changed();
  }

  scrubTo(eventTime: number): void {
    if (this.mode === "live") this.pause();
    const lo = this.domainMin;
    const hi = Math.max(this.domainMax, lo);
    this.cursor = cursorOf(Math.min(Math.max(eventTime, lo), hi), this.pinnedIngest);
    this.changed();
  }

  setIngestCursor(seq: number): void {
    if (this.mode === "live") this.pause();
    const n = Math.max(0, Math.min(Math.floor(seq), this.head.ingestSequence));
    this.pinnedIngest = n;
    this.cursor = cursorOf(this.cursor.eventTime, n);
    this.changed();
  }

  absorbLatest(): void {
    if (this.mode !== "paused") return;
    this.pinnedIngest = this.head.ingestSequence;
    this.cursor = cursorOf(this.cursor.eventTime, this.pinnedIngest);
    this.changed();
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.changed();
  }

  setServiceFilter(f: string | null): void {
    this.serviceFilter = f;
    this.changed();
  }
}

export function useReplay(store: ReplayStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
