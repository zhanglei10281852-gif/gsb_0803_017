import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import {
  CreateSnapshotRequest,
  IncidentSnapshot,
  IngestResponse,
  LedgerRecord,
  LiveLedgerEvent,
  ReplayCursor,
  ReplayView,
  SpanDetail,
  SpanEvent,
} from "../shared/contracts";
import { LedgerStore } from "./ledgerStore";
import { ReplayEngine } from "./replayEngine";
import { buildSnapshot } from "./snapshotEngine";

export class ReplayService {
  private records: LedgerRecord[];
  private engine: ReplayEngine;

  constructor(private readonly ledger: LedgerStore) {
    this.records = [...ledger.loadAll()];
    this.engine = new ReplayEngine(this.records);
  }

  get totalRecords(): number {
    return this.records.length;
  }

  getEngine(): ReplayEngine {
    return this.engine;
  }

  get maxIngestSequence(): number {
    return this.records.length === 0
      ? 0
      : this.records[this.records.length - 1]!.ingestSequence;
  }

  liveCursor(): ReplayCursor {
    return this.engine.liveCursor();
  }

  buildView(cursor: ReplayCursor, live: boolean): ReplayView {
    return this.engine.buildView(cursor, live);
  }

  buildSpanDetail(
    traceId: string,
    spanId: string,
    cursor: ReplayCursor,
  ): SpanDetail | null {
    return this.engine.buildSpanDetail(traceId, spanId, cursor);
  }

  ingest(events: readonly SpanEvent[]): IngestResponse {
    if (events.length === 0) {
      return {
        contractVersion: 1,
        accepted: 0,
        rejected: 0,
        firstIngestSequence: null,
        lastIngestSequence: null,
        errors: [],
      };
    }
    const result = this.ledger.append(events);
    this.records.push(...result.records);
    const first = result.records[0]!;
    const last = result.records[result.records.length - 1]!;
    return {
      contractVersion: 1,
      accepted: result.records.length,
      rejected: 0,
      firstIngestSequence: first.ingestSequence,
      lastIngestSequence: last.ingestSequence,
      errors: [],
    };
  }

  close(): void {
    this.ledger.close();
  }

  createSnapshot(
    request: CreateSnapshotRequest,
    now: number = Date.now(),
  ): IncidentSnapshot {
    const snapshot = buildSnapshot(
      randomUUID(),
      now,
      request.labelA ?? "A",
      request.labelB ?? "B",
      request.cursorA,
      request.cursorB,
      request.notes ?? "",
      this.engine,
      this.records,
    );
    this.ledger.saveSnapshot(snapshot);
    return snapshot;
  }

  listSnapshots(): IncidentSnapshot[] {
    return this.ledger.listSnapshots();
  }

  getSnapshot(id: string): IncidentSnapshot | null {
    return this.ledger.getSnapshot(id);
  }

  updateSnapshotNotes(id: string, notes: string): IncidentSnapshot | null {
    return this.ledger.updateSnapshotNotes(id, notes);
  }
}

export type { LiveLedgerEvent };
