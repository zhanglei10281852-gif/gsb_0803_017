import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerRecord, RawSpanEvent, ReplayCursor } from '../shared/contracts.js';
import { emptyHead } from '../shared/contracts.js';

interface LedgerRow {
  ingest_sequence: number;
  ingest_time: number;
  event_json: string;
}

export class LedgerStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement<[number, number, string]>;
  private readonly headSeqStmt: Database.Statement<[]>;
  private nextSequence: number;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        ingest_sequence INTEGER PRIMARY KEY,
        ingest_time     INTEGER NOT NULL,
        event_json      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_event_time ON ledger(
        json_extract(event_json, '$.eventTime')
      );
    `);

    const row = this.db
      .prepare('SELECT COALESCE(MAX(ingest_sequence), 0) AS max_seq FROM ledger')
      .get() as { max_seq: number };
    this.nextSequence = row.max_seq + 1;

    this.insertStmt = this.db.prepare(
      'INSERT INTO ledger (ingest_sequence, ingest_time, event_json) VALUES (?, ?, ?)',
    );
    this.headSeqStmt = this.db.prepare(
      'SELECT MAX(ingest_sequence) AS max_seq FROM ledger',
    );
  }

  append(event: RawSpanEvent, ingestTime: number = Date.now()): LedgerRecord {
    const ingestSequence = this.nextSequence;
    const eventJson = JSON.stringify(event);
    this.insertStmt.run(ingestSequence, ingestTime, eventJson);
    this.nextSequence++;
    return { ingestSequence, ingestTime, event };
  }

  appendMany(
    events: RawSpanEvent[],
    ingestTime: number = Date.now(),
  ): LedgerRecord[] {
    const records: LedgerRecord[] = [];
    const txn = this.db.transaction((evts: RawSpanEvent[]) => {
      for (const event of evts) {
        const seq = this.nextSequence;
        this.insertStmt.run(seq, ingestTime, JSON.stringify(event));
        this.nextSequence++;
        records.push({ ingestSequence: seq, ingestTime, event });
      }
    });
    txn(events);
    return records;
  }

  getHeadSequence(): number {
    const row = this.headSeqStmt.get() as { max_seq: number | null };
    return row.max_seq ?? 0;
  }

  getHead(): ReplayCursor {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(MAX(ingest_sequence), 0) AS max_seq,
           COALESCE(MAX(json_extract(event_json, '$.eventTime')), 0) AS max_event_time
         FROM ledger`,
      )
      .get() as { max_seq: number; max_event_time: number };
    if (row.max_seq === 0) return emptyHead();
    return {
      eventTime: row.max_event_time,
      ingestSequence: row.max_seq,
    };
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM ledger')
      .get() as { c: number };
    return row.c;
  }

  getAllRecords(): LedgerRecord[] {
    const rows = this.db
      .prepare(
        'SELECT ingest_sequence, ingest_time, event_json FROM ledger ORDER BY ingest_sequence ASC',
      )
      .all() as LedgerRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  getRecordsSince(ingestSequence: number): LedgerRecord[] {
    const rows = this.db
      .prepare(
        'SELECT ingest_sequence, ingest_time, event_json FROM ledger WHERE ingest_sequence > ? ORDER BY ingest_sequence ASC',
      )
      .all(ingestSequence) as LedgerRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: LedgerRow): LedgerRecord {
    const event = JSON.parse(row.event_json) as RawSpanEvent;
    return {
      ingestSequence: row.ingest_sequence,
      ingestTime: row.ingest_time,
      event,
    };
  }
}
