import { EventEmitter } from 'node:events';
import type {
  LedgerRecord,
  RawSpanEvent,
  ReplayCursor,
  ReplayView,
  SpanVersionExplanation,
} from '../shared/contracts.js';
import {
  buildReplayView,
  computeHead,
  explainSpanVersions,
} from '../shared/projection.js';
import type { LedgerStore } from './db.js';

export type EngineListener = (record: LedgerRecord, head: ReplayCursor) => void;

export class ReplayEngine {
  private readonly store: LedgerStore;
  private records: LedgerRecord[];
  private readonly emitter: EventEmitter;

  constructor(store: LedgerStore) {
    this.store = store;
    this.records = store.getAllRecords();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  ingest(event: RawSpanEvent): LedgerRecord {
    const record = this.store.append(event);
    this.records.push(record);
    const head = computeHead(this.records);
    this.emitter.emit('record', record, head);
    return record;
  }

  ingestMany(events: RawSpanEvent[]): LedgerRecord[] {
    if (events.length === 0) return [];
    const records = this.store.appendMany(events);
    this.records.push(...records);
    const head = computeHead(this.records);
    for (const r of records) {
      this.emitter.emit('record', r, head);
    }
    return records;
  }

  getHead(): ReplayCursor {
    return computeHead(this.records);
  }

  totalRecords(): number {
    return this.records.length;
  }

  getAllRecords(): readonly LedgerRecord[] {
    return this.records;
  }

  getView(cursor: ReplayCursor): ReplayView {
    return buildReplayView(this.records, cursor, this.records.length);
  }

  getViewAtHead(): ReplayView {
    return this.getView(this.getHead());
  }

  explainSpan(
    traceId: string,
    spanId: string,
    cursor: ReplayCursor,
  ): SpanVersionExplanation[] {
    return explainSpanVersions(this.records, traceId, spanId, cursor);
  }

  getRecordsSince(ingestSequence: number): LedgerRecord[] {
    return this.records.filter((r) => r.ingestSequence > ingestSequence);
  }

  subscribe(listener: EngineListener): () => void {
    this.emitter.on('record', listener);
    return () => {
      this.emitter.off('record', listener);
    };
  }

  close(): void {
    this.emitter.removeAllListeners();
    this.store.close();
  }
}
