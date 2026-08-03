import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { LedgerRecord, SpanAttributes, SpanEvent } from '../shared/contracts';

interface LedgerRow {
  ingest_sequence: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service: string;
  operation: string;
  kind: LedgerRecord['kind'];
  status: LedgerRecord['status'];
  start_time: number;
  end_time: number;
  revision: number;
  event_time: number;
  error_message: string | null;
  attributes: string;
  received_at: number;
}

export interface AppendResult {
  readonly records: readonly LedgerRecord[];
}

export interface LedgerInfo {
  readonly totalRecords: number;
  readonly minIngestSequence: number;
  readonly maxIngestSequence: number;
  readonly minEventTime: number;
  readonly maxEventTime: number;
}

function rowToRecord(row: LedgerRow): LedgerRecord {
  const parsedAttributes = JSON.parse(row.attributes) as SpanAttributes;
  return {
    ingestSequence: row.ingest_sequence,
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    service: row.service,
    operation: row.operation,
    kind: row.kind,
    status: row.status,
    startTime: row.start_time,
    endTime: row.end_time,
    revision: row.revision,
    eventTime: row.event_time,
    errorMessage: row.error_message,
    attributes: parsedAttributes,
    receivedAt: row.received_at
  };
}

export class LedgerStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly lastSeqStmt: Database.Statement;
  private readonly allStmt: Database.Statement;
  private readonly rangeStmt: Database.Statement;
  private readonly versionsStmt: Database.Statement;
  private readonly infoStmt: Database.Statement;

  constructor(dbPath: string) {
    const absolutePath = resolve(dbPath);
    const parent = dirname(absolutePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    this.db = new Database(absolutePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS span_ledger (
        ingest_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        event_time INTEGER NOT NULL,
        error_message TEXT,
        attributes TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_trace_span ON span_ledger(trace_id, span_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_ingest ON span_ledger(ingest_sequence);
      CREATE INDEX IF NOT EXISTS idx_ledger_event_time ON span_ledger(event_time);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO span_ledger
        (trace_id, span_id, parent_span_id, service, operation, kind, status,
         start_time, end_time, revision, event_time, error_message, attributes, received_at)
      VALUES (@trace_id, @span_id, @parent_span_id, @service, @operation, @kind, @status,
              @start_time, @end_time, @revision, @event_time, @error_message, @attributes, @received_at)
    `);
    this.lastSeqStmt = this.db.prepare('SELECT last_insert_rowid() AS seq');
    this.allStmt = this.db.prepare(
      'SELECT * FROM span_ledger ORDER BY ingest_sequence ASC'
    );
    this.rangeStmt = this.db.prepare(
      'SELECT * FROM span_ledger WHERE ingest_sequence <= ? ORDER BY ingest_sequence ASC'
    );
    this.versionsStmt = this.db.prepare(
      'SELECT * FROM span_ledger WHERE trace_id = ? AND span_id = ? ORDER BY ingest_sequence ASC'
    );
    this.infoStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(MIN(ingest_sequence), 0) AS min_seq,
        COALESCE(MAX(ingest_sequence), 0) AS max_seq,
        COALESCE(MIN(event_time), 0) AS min_event,
        COALESCE(MAX(event_time), 0) AS max_event
      FROM span_ledger
    `);
  }

  append(events: readonly SpanEvent[], now: number = Date.now()): AppendResult {
    const records: LedgerRecord[] = [];
    const tx = this.db.transaction((batch: readonly SpanEvent[]) => {
      for (const event of batch) {
        const receivedAt = now;
        this.insertStmt.run({
          trace_id: event.traceId,
          span_id: event.spanId,
          parent_span_id: event.parentSpanId,
          service: event.service,
          operation: event.operation,
          kind: event.kind,
          status: event.status,
          start_time: event.startTime,
          end_time: event.endTime,
          revision: event.revision,
          event_time: event.eventTime,
          error_message: event.errorMessage ?? null,
          attributes: JSON.stringify(event.attributes ?? {}),
          received_at: receivedAt
        });
        const lastRow = this.lastSeqStmt.get() as { seq: number };
        const lastSeq = lastRow.seq;
        records.push({
          ingestSequence: lastSeq,
          traceId: event.traceId,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId,
          service: event.service,
          operation: event.operation,
          kind: event.kind,
          status: event.status,
          startTime: event.startTime,
          endTime: event.endTime,
          revision: event.revision,
          eventTime: event.eventTime,
          errorMessage: event.errorMessage ?? null,
          attributes: event.attributes ?? {},
          receivedAt
        });
      }
    });
    tx(events);
    return { records };
  }

  loadAll(): readonly LedgerRecord[] {
    const rows = this.allStmt.all() as LedgerRow[];
    return rows.map(rowToRecord);
  }

  loadUpTo(ingestSequence: number): readonly LedgerRecord[] {
    const rows = this.rangeStmt.all(ingestSequence) as LedgerRow[];
    return rows.map(rowToRecord);
  }

  loadVersions(traceId: string, spanId: string): readonly LedgerRecord[] {
    const rows = this.versionsStmt.all(traceId, spanId) as LedgerRow[];
    return rows.map(rowToRecord);
  }

  getInfo(): LedgerInfo {
    const row = this.infoStmt.get() as {
      total: number;
      min_seq: number;
      max_seq: number;
      min_event: number;
      max_event: number;
    };
    return {
      totalRecords: row.total,
      minIngestSequence: row.min_seq,
      maxIngestSequence: row.max_seq,
      minEventTime: row.min_event,
      maxEventTime: row.max_event
    };
  }

  close(): void {
    this.db.close();
  }
}
