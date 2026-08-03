import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type {
  LedgerRecord,
  RawSpanEvent,
  ReplayCursor,
  ReplayView,
  SpanVersionExplanation,
  IncidentSnapshot,
  SnapshotSlot,
  SnapshotDiff,
  LeaseError,
} from '../shared/contracts.js';
import {
  buildReplayView,
  computeHead,
  explainSpanVersions,
  buildDigestInput,
  buildSnapshotDiff,
  isRecordVisible,
} from '../shared/projection.js';
import type { LedgerStore } from './db.js';
import { SnapshotStore } from './snapshotStore.js';
import { SessionStore } from './sessionStore.js';
import { SessionService } from './session.js';

export type EngineListener = (record: LedgerRecord, head: ReplayCursor) => void;

export class FencingError extends Error {
  readonly leaseError: LeaseError;
  constructor(leaseError: LeaseError) {
    super(leaseError.message);
    this.name = 'FencingError';
    this.leaseError = leaseError;
  }
}

export class ReplayEngine {
  private readonly store: LedgerStore;
  private readonly snapshots: SnapshotStore;
  private readonly session: SessionService;
  private records: LedgerRecord[];
  private readonly emitter: EventEmitter;

  constructor(store: LedgerStore, clock?: () => number) {
    this.store = store;
    this.records = store.getAllRecords();
    const db = store.getDatabase();
    this.snapshots = new SnapshotStore(db);
    this.session = new SessionService(new SessionStore(db), clock);
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  getSession(): SessionService {
    return this.session;
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

  computeDigest(cursor: ReplayCursor): { digest: string; visibleRecordCount: number } {
    const visible = this.records.filter((r) => isRecordVisible(r, cursor));
    const input = buildDigestInput(visible);
    const digest = createHash('sha256').update(input).digest('hex');
    return { digest, visibleRecordCount: visible.length };
  }

  createSnapshot(
    slot: SnapshotSlot,
    label: string,
    cursor: ReplayCursor,
    notes: string,
    fencing?: { clientId: string | null; token: number | null } | null,
  ): IncidentSnapshot {
    const fencingErr = this.session.validateFencing(
      fencing?.clientId ?? null,
      fencing?.token ?? null,
    );
    if (fencingErr) {
      throw new FencingError(fencingErr);
    }
    const ledgerHead = this.getHead();
    const { digest, visibleRecordCount } = this.computeDigest(cursor);
    return this.snapshots.create({
      slot,
      label,
      cursor,
      ledgerHead,
      totalLedgerRecords: this.records.length,
      visibleRecordCount,
      digest,
      notes,
      createdAt: Date.now(),
    });
  }

  listSnapshots(): IncidentSnapshot[] {
    return this.snapshots.list();
  }

  getSnapshot(id: string): IncidentSnapshot | null {
    return this.snapshots.getById(id);
  }

  getLatestSnapshot(slot: SnapshotSlot): IncidentSnapshot | null {
    return this.snapshots.getLatestBySlot(slot);
  }

  updateSnapshotNotes(id: string, notes: string): IncidentSnapshot | null {
    return this.snapshots.updateNotes(id, notes);
  }

  compareSnapshots(aId: string, bId: string): SnapshotDiff {
    const a = this.snapshots.getById(aId);
    const b = this.snapshots.getById(bId);
    if (!a) throw new Error(`snapshot A not found: ${aId}`);
    if (!b) throw new Error(`snapshot B not found: ${bId}`);
    const viewA = this.getView(a.cursor);
    const viewB = this.getView(b.cursor);
    return buildSnapshotDiff(a, b, viewA, viewB);
  }

  compareLatestAB(): SnapshotDiff | null {
    const a = this.snapshots.getLatestBySlot('A');
    const b = this.snapshots.getLatestBySlot('B');
    if (!a || !b) return null;
    return this.compareSnapshots(a.id, b.id);
  }

  close(): void {
    this.emitter.removeAllListeners();
    this.session.close();
    this.store.close();
  }
}
