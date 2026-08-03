import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  IncidentSnapshot,
  ReplayCursor,
  SnapshotSlot,
} from '../shared/contracts.js';

interface SnapshotRow {
  id: string;
  slot: string;
  label: string;
  cursor_event_time: number;
  cursor_ingest_sequence: number;
  ledger_head_event_time: number;
  ledger_head_ingest_sequence: number;
  total_ledger_records: number;
  visible_record_count: number;
  digest: string;
  created_at: number;
  notes: string;
}

export interface CreateSnapshotInput {
  slot: SnapshotSlot;
  label: string;
  cursor: ReplayCursor;
  ledgerHead: ReplayCursor;
  totalLedgerRecords: number;
  visibleRecordCount: number;
  digest: string;
  notes: string;
  createdAt: number;
}

export class SnapshotStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement<unknown[]>;
  private readonly listStmt: Database.Statement<[]>;
  private readonly getByIdStmt: Database.Statement<[string]>;
  private readonly getLatestBySlotStmt: Database.Statement<[string]>;
  private readonly updateNotesStmt: Database.Statement<[string, string]>;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        slot TEXT NOT NULL,
        label TEXT NOT NULL,
        cursor_event_time INTEGER NOT NULL,
        cursor_ingest_sequence INTEGER NOT NULL,
        ledger_head_event_time INTEGER NOT NULL,
        ledger_head_ingest_sequence INTEGER NOT NULL,
        total_ledger_records INTEGER NOT NULL,
        visible_record_count INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        notes TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_slot_created ON snapshots(slot, created_at DESC);
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO snapshots
        (id, slot, label, cursor_event_time, cursor_ingest_sequence,
         ledger_head_event_time, ledger_head_ingest_sequence,
         total_ledger_records, visible_record_count, digest, created_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listStmt = this.db.prepare(
      'SELECT * FROM snapshots ORDER BY created_at DESC, rowid DESC',
    );
    this.getByIdStmt = this.db.prepare('SELECT * FROM snapshots WHERE id = ?');
    this.getLatestBySlotStmt = this.db.prepare(
      'SELECT * FROM snapshots WHERE slot = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    this.updateNotesStmt = this.db.prepare(
      'UPDATE snapshots SET notes = ? WHERE id = ?',
    );
  }

  create(input: CreateSnapshotInput): IncidentSnapshot {
    const id = randomUUID();
    this.insertStmt.run(
      id,
      input.slot,
      input.label,
      input.cursor.eventTime,
      input.cursor.ingestSequence,
      input.ledgerHead.eventTime,
      input.ledgerHead.ingestSequence,
      input.totalLedgerRecords,
      input.visibleRecordCount,
      input.digest,
      input.createdAt,
      input.notes,
    );
    return this.rowToSnapshot({
      id,
      slot: input.slot,
      label: input.label,
      cursor_event_time: input.cursor.eventTime,
      cursor_ingest_sequence: input.cursor.ingestSequence,
      ledger_head_event_time: input.ledgerHead.eventTime,
      ledger_head_ingest_sequence: input.ledgerHead.ingestSequence,
      total_ledger_records: input.totalLedgerRecords,
      visible_record_count: input.visibleRecordCount,
      digest: input.digest,
      created_at: input.createdAt,
      notes: input.notes,
    });
  }

  list(): IncidentSnapshot[] {
    const rows = this.listStmt.all() as SnapshotRow[];
    return rows.map((r) => this.rowToSnapshot(r));
  }

  getById(id: string): IncidentSnapshot | null {
    const row = this.getByIdStmt.get(id) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  getLatestBySlot(slot: SnapshotSlot): IncidentSnapshot | null {
    const row = this.getLatestBySlotStmt.get(slot) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  updateNotes(id: string, notes: string): IncidentSnapshot | null {
    this.updateNotesStmt.run(notes, id);
    return this.getById(id);
  }

  private rowToSnapshot(row: SnapshotRow): IncidentSnapshot {
    return {
      id: row.id,
      slot: row.slot as SnapshotSlot,
      label: row.label,
      cursor: {
        eventTime: row.cursor_event_time,
        ingestSequence: row.cursor_ingest_sequence,
      },
      ledgerHead: {
        eventTime: row.ledger_head_event_time,
        ingestSequence: row.ledger_head_ingest_sequence,
      },
      totalLedgerRecords: row.total_ledger_records,
      visibleRecordCount: row.visible_record_count,
      digest: row.digest,
      createdAt: row.created_at,
      notes: row.notes,
    };
  }
}
