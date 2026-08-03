import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CONTRACT_VERSION,
  type LedgerRecord,
  type SpanEventInput,
} from '../shared/contract';
import { computeBounds, type LedgerBounds } from '../shared/projection';

/**
 * The append-only ledger. It is the single source of truth: every span
 * revision that ever arrives is stored forever with a server-assigned,
 * monotonically increasing `ingestSequence` (the SQLite AUTOINCREMENT rowid).
 *
 * Nothing is ever updated or deleted. Projections are derived on read, so the
 * store survives process restarts with zero re-ingestion and any historical
 * view remains reproducible.
 */
export class Ledger {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly existsStmt: Database.Statement;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    // Prepared after migrate so the target table exists. Kept as fields so the
    // hot ingest path reuses compiled statements.
    this.existsStmt = this.db.prepare(
      'SELECT 1 FROM ledger WHERE traceId = ? AND spanId = ? AND revision = ? LIMIT 1',
    );
    this.insertStmt = this.db.prepare(`
      INSERT INTO ledger (
        contractVersion, traceId, spanId, parentSpanId, service, operation,
        revision, eventTimeMs, durationMs, status, revisionReason, errorKind, receivedAtMs
      ) VALUES (
        @contractVersion, @traceId, @spanId, @parentSpanId, @service, @operation,
        @revision, @eventTimeMs, @durationMs, @status, @revisionReason, @errorKind, @receivedAtMs
      )
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Immutable append-only ledger. ingestSequence is AUTOINCREMENT so it is
      -- strictly monotonic and never reused, even across restarts.
      CREATE TABLE IF NOT EXISTS ledger (
        ingestSequence INTEGER PRIMARY KEY AUTOINCREMENT,
        contractVersion INTEGER NOT NULL,
        traceId        TEXT    NOT NULL,
        spanId         TEXT    NOT NULL,
        parentSpanId   TEXT,
        service        TEXT    NOT NULL,
        operation      TEXT    NOT NULL,
        revision       INTEGER NOT NULL,
        eventTimeMs    INTEGER NOT NULL,
        durationMs     INTEGER NOT NULL,
        status         TEXT    NOT NULL,
        revisionReason TEXT,
        errorKind      TEXT,
        receivedAtMs   INTEGER NOT NULL,
        -- Idempotency key: an identical (trace,span,revision) re-send is a
        -- duplicate and must NOT create a new ledger row.
        UNIQUE (traceId, spanId, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_time ON ledger (eventTimeMs);
      CREATE INDEX IF NOT EXISTS idx_ledger_span ON ledger (traceId, spanId, revision);
    `);

    const existing = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('contractVersion') as { value: string } | undefined;
    if (existing === undefined) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('contractVersion', String(CONTRACT_VERSION));
    } else if (Number(existing.value) !== CONTRACT_VERSION) {
      throw new Error(
        `Ledger contract version ${existing.value} is incompatible with runtime ${CONTRACT_VERSION}`,
      );
    }
  }

  /**
   * Append one event. Returns the assigned ingestSequence, or null when the
   * exact (traceId, spanId, revision) already exists (idempotent duplicate).
   */
  append(event: SpanEventInput, receivedAtMs: number): LedgerRecord | null {
    // Idempotency: an exact (traceId, spanId, revision) re-send is a duplicate.
    // We check first (rather than INSERT OR IGNORE) so AUTOINCREMENT never
    // advances on a rejected row, keeping ingestSequence contiguous.
    const already = this.existsStmt.get(event.traceId, event.spanId, event.revision);
    if (already !== undefined) return null;
    const info = this.insertStmt.run({
      contractVersion: event.contractVersion,
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      service: event.service,
      operation: event.operation,
      revision: event.revision,
      eventTimeMs: event.eventTimeMs,
      durationMs: event.durationMs,
      status: event.status,
      revisionReason: event.revisionReason,
      errorKind: event.errorKind,
      receivedAtMs,
    });
    if (info.changes === 0) return null; // defensive; should not happen
    const ingestSequence = Number(info.lastInsertRowid);
    return { ...event, ingestSequence, receivedAtMs };
  }

  /** Append a batch atomically. Returns accepted records and duplicate count. */
  appendBatch(
    events: readonly SpanEventInput[],
    receivedAtMs: number,
  ): { accepted: LedgerRecord[]; duplicates: number } {
    const accepted: LedgerRecord[] = [];
    let duplicates = 0;
    const tx = this.db.transaction((batch: readonly SpanEventInput[]) => {
      for (const ev of batch) {
        const rec = this.append(ev, receivedAtMs);
        if (rec === null) duplicates += 1;
        else accepted.push(rec);
      }
    });
    tx(events);
    return { accepted, duplicates };
  }

  /** Read the entire immutable ledger, ordered by ingestSequence. */
  readAll(): LedgerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger ORDER BY ingestSequence ASC')
      .all() as RawRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Read only the records needed to reproduce a view: everything with
   * ingestSequence <= the cursor's ingestSequence. eventTime filtering happens
   * in the pure projection so a single query serves any timeline scrub.
   */
  readUpToIngest(maxIngestSequence: number): LedgerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger WHERE ingestSequence <= ? ORDER BY ingestSequence ASC')
      .all(maxIngestSequence) as RawRow[];
    return rows.map(rowToRecord);
  }

  bounds(): LedgerBounds {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(MIN(eventTimeMs), 0)      AS minEventTimeMs,
           COALESCE(MAX(eventTimeMs), 0)      AS maxEventTimeMs,
           COALESCE(MAX(ingestSequence), 0)   AS maxIngestSequence
         FROM ledger`,
      )
      .get() as LedgerBounds;
    return row;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM ledger').get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

interface RawRow {
  ingestSequence: number;
  contractVersion: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operation: string;
  revision: number;
  eventTimeMs: number;
  durationMs: number;
  status: string;
  revisionReason: string | null;
  errorKind: string | null;
  receivedAtMs: number;
}

function rowToRecord(row: RawRow): LedgerRecord {
  return {
    contractVersion: CONTRACT_VERSION,
    ingestSequence: row.ingestSequence,
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    service: row.service,
    operation: row.operation,
    revision: row.revision,
    eventTimeMs: row.eventTimeMs,
    durationMs: row.durationMs,
    status: row.status === 'error' ? 'error' : 'ok',
    revisionReason: row.revisionReason,
    errorKind: row.errorKind,
    receivedAtMs: row.receivedAtMs,
  };
}

// Re-export for callers that build bounds from an in-memory record slice.
export { computeBounds };
