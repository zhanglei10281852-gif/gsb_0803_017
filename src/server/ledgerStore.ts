import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import {
  FencingToken,
  IncidentSnapshot,
  InvestigationSession,
  LedgerRecord,
  SessionNoteEntry,
  SharedCursor,
  SpanAttributes,
  SpanEvent,
} from "../shared/contracts";

interface LedgerRow {
  ingest_sequence: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service: string;
  operation: string;
  kind: LedgerRecord["kind"];
  status: LedgerRecord["status"];
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
    receivedAt: row.received_at,
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
  private readonly insertSnapshotStmt: Database.Statement;
  private readonly listSnapshotsStmt: Database.Statement;
  private readonly getSnapshotStmt: Database.Statement;
  private readonly updateNotesStmt: Database.Statement;
  private readonly insertSessionStmt: Database.Statement;
  private readonly getSessionStmt: Database.Statement;
  private readonly updateLeaseStmt: Database.Statement;
  private readonly updateSharedCursorStmt: Database.Statement;
  private readonly updateSnapshotIdsStmt: Database.Statement;
  private readonly insertNoteStmt: Database.Statement;
  private readonly maxNoteSeqStmt: Database.Statement;
  private readonly listNotesStmt: Database.Statement;
  private readonly noteExistsStmt: Database.Statement;

  constructor(dbPath: string) {
    const absolutePath = resolve(dbPath);
    const parent = dirname(absolutePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    this.db = new Database(absolutePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
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

      CREATE TABLE IF NOT EXISTS incident_snapshots (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        label_a TEXT NOT NULL,
        label_b TEXT NOT NULL,
        cursor_a TEXT NOT NULL,
        cursor_b TEXT NOT NULL,
        digest_a TEXT NOT NULL,
        digest_b TEXT NOT NULL,
        diff TEXT NOT NULL,
        notes TEXT NOT NULL,
        sealed INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_created ON incident_snapshots(created_at);

      CREATE TABLE IF NOT EXISTS investigation_sessions (
        id TEXT PRIMARY KEY,
        anchor_snapshot_id TEXT NOT NULL,
        anchor_digest_a TEXT NOT NULL,
        anchor_digest_b TEXT NOT NULL,
        lease_leader_id TEXT,
        lease_leader_name TEXT,
        lease_fencing_token INTEGER,
        lease_acquired_at INTEGER,
        lease_expires_at INTEGER,
        shared_cursor TEXT,
        snapshot_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_notes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        participant_name TEXT NOT NULL,
        text TEXT NOT NULL,
        seq INTEGER NOT NULL,
        client_note_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, client_note_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes(session_id, seq);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO span_ledger
        (trace_id, span_id, parent_span_id, service, operation, kind, status,
         start_time, end_time, revision, event_time, error_message, attributes, received_at)
      VALUES (@trace_id, @span_id, @parent_span_id, @service, @operation, @kind, @status,
              @start_time, @end_time, @revision, @event_time, @error_message, @attributes, @received_at)
    `);
    this.lastSeqStmt = this.db.prepare("SELECT last_insert_rowid() AS seq");
    this.allStmt = this.db.prepare(
      "SELECT * FROM span_ledger ORDER BY ingest_sequence ASC",
    );
    this.rangeStmt = this.db.prepare(
      "SELECT * FROM span_ledger WHERE ingest_sequence <= ? ORDER BY ingest_sequence ASC",
    );
    this.versionsStmt = this.db.prepare(
      "SELECT * FROM span_ledger WHERE trace_id = ? AND span_id = ? ORDER BY ingest_sequence ASC",
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
    this.insertSnapshotStmt = this.db.prepare(`
      INSERT INTO incident_snapshots
        (id, created_at, label_a, label_b, cursor_a, cursor_b, digest_a, digest_b, diff, notes, sealed)
      VALUES (@id, @created_at, @label_a, @label_b, @cursor_a, @cursor_b, @digest_a, @digest_b, @diff, @notes, 1)
    `);
    this.listSnapshotsStmt = this.db.prepare(
      "SELECT * FROM incident_snapshots ORDER BY created_at DESC, id DESC",
    );
    this.getSnapshotStmt = this.db.prepare(
      "SELECT * FROM incident_snapshots WHERE id = ?",
    );
    this.updateNotesStmt = this.db.prepare(
      "UPDATE incident_snapshots SET notes = @notes WHERE id = @id",
    );

    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO investigation_sessions
        (id, anchor_snapshot_id, anchor_digest_a, anchor_digest_b,
         lease_leader_id, lease_leader_name, lease_fencing_token, lease_acquired_at, lease_expires_at,
         shared_cursor, snapshot_ids, created_at, updated_at)
      VALUES (@id, @anchor_snapshot_id, @anchor_digest_a, @anchor_digest_b,
              @lease_leader_id, @lease_leader_name, @lease_fencing_token, @lease_acquired_at, @lease_expires_at,
              @shared_cursor, @snapshot_ids, @created_at, @updated_at)
    `);
    this.getSessionStmt = this.db.prepare(
      "SELECT * FROM investigation_sessions WHERE id = ?",
    );
    this.updateLeaseStmt = this.db.prepare(`
      UPDATE investigation_sessions
      SET lease_leader_id = @leader_id, lease_leader_name = @leader_name,
          lease_fencing_token = @fencing_token, lease_acquired_at = @acquired_at,
          lease_expires_at = @expires_at, updated_at = @updated_at
      WHERE id = @id
    `);
    this.updateSharedCursorStmt = this.db.prepare(
      "UPDATE investigation_sessions SET shared_cursor = @shared_cursor, updated_at = @updated_at WHERE id = @id",
    );
    this.updateSnapshotIdsStmt = this.db.prepare(
      "UPDATE investigation_sessions SET snapshot_ids = @snapshot_ids, updated_at = @updated_at WHERE id = @id",
    );
    this.insertNoteStmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_notes
        (id, session_id, participant_id, participant_name, text, seq, client_note_id, created_at)
      VALUES (@id, @session_id, @participant_id, @participant_name, @text, @seq, @client_note_id, @created_at)
    `);
    this.maxNoteSeqStmt = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_notes WHERE session_id = ?",
    );
    this.listNotesStmt = this.db.prepare(
      "SELECT * FROM session_notes WHERE session_id = ? ORDER BY seq ASC, id ASC",
    );
    this.noteExistsStmt = this.db.prepare(
      "SELECT * FROM session_notes WHERE session_id = ? AND client_note_id = ?",
    );
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
          received_at: receivedAt,
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
          receivedAt,
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
      maxEventTime: row.max_event,
    };
  }

  close(): void {
    this.db.close();
  }

  saveSnapshot(snapshot: IncidentSnapshot): void {
    this.insertSnapshotStmt.run({
      id: snapshot.id,
      created_at: snapshot.createdAt,
      label_a: snapshot.labelA,
      label_b: snapshot.labelB,
      cursor_a: JSON.stringify(snapshot.cursorA),
      cursor_b: JSON.stringify(snapshot.cursorB),
      digest_a: JSON.stringify(snapshot.digestA),
      digest_b: JSON.stringify(snapshot.digestB),
      diff: JSON.stringify(snapshot.diff),
      notes: snapshot.notes,
    });
  }

  listSnapshots(): IncidentSnapshot[] {
    const rows = this.listSnapshotsStmt.all() as SnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  getSnapshot(id: string): IncidentSnapshot | null {
    const row = this.getSnapshotStmt.get(id) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  updateSnapshotNotes(id: string, notes: string): IncidentSnapshot | null {
    this.updateNotesStmt.run({ id, notes });
    return this.getSnapshot(id);
  }

  saveSession(session: InvestigationSession): void {
    this.insertSessionStmt.run({
      id: session.id,
      anchor_snapshot_id: session.anchorSnapshotId,
      anchor_digest_a: session.anchorDigestA,
      anchor_digest_b: session.anchorDigestB,
      lease_leader_id: session.lease?.leaderId ?? null,
      lease_leader_name: session.lease?.leaderName ?? null,
      lease_fencing_token: session.lease?.token ?? null,
      lease_acquired_at: session.lease?.acquiredAt ?? null,
      lease_expires_at: session.lease?.expiresAt ?? null,
      shared_cursor: session.sharedCursor
        ? JSON.stringify(session.sharedCursor)
        : null,
      snapshot_ids: JSON.stringify(session.snapshotIds),
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    });
  }

  getSessionRow(id: string): SessionRow | null {
    const row = this.getSessionStmt.get(id) as SessionRow | undefined;
    return row ?? null;
  }

  updateLease(id: string, lease: FencingToken | null, now: number): void {
    this.updateLeaseStmt.run({
      id,
      leader_id: lease?.leaderId ?? null,
      leader_name: lease?.leaderName ?? null,
      fencing_token: lease?.token ?? null,
      acquired_at: lease?.acquiredAt ?? null,
      expires_at: lease?.expiresAt ?? null,
      updated_at: now,
    });
  }

  updateSharedCursor(
    id: string,
    sharedCursor: SharedCursor | null,
    now: number,
  ): void {
    this.updateSharedCursorStmt.run({
      id,
      shared_cursor: sharedCursor ? JSON.stringify(sharedCursor) : null,
      updated_at: now,
    });
  }

  updateSessionSnapshotIds(
    id: string,
    snapshotIds: readonly string[],
    now: number,
  ): void {
    this.updateSnapshotIdsStmt.run({
      id,
      snapshot_ids: JSON.stringify(snapshotIds),
      updated_at: now,
    });
  }

  addSessionNote(
    sessionId: string,
    noteId: string,
    entry: Omit<SessionNoteEntry, "id"> & { clientNoteId: string },
  ): boolean {
    const info = this.insertNoteStmt.run({
      id: noteId,
      session_id: sessionId,
      participant_id: entry.participantId,
      participant_name: entry.participantName,
      text: entry.text,
      seq: entry.seq,
      client_note_id: entry.clientNoteId,
      created_at: entry.createdAt,
    });
    return info.changes > 0;
  }

  noteExists(sessionId: string, clientNoteId: string): boolean {
    const row = this.noteExistsStmt.get(sessionId, clientNoteId) as
      | NoteRow
      | undefined;
    return Boolean(row);
  }

  maxNoteSeq(sessionId: string): number {
    const row = this.maxNoteSeqStmt.get(sessionId) as { max_seq: number };
    return row.max_seq;
  }

  listSessionNotes(sessionId: string): SessionNoteEntry[] {
    const rows = this.listNotesStmt.all(sessionId) as NoteRow[];
    return rows.map((row) => ({
      id: row.id,
      participantId: row.participant_id,
      participantName: row.participant_name,
      text: row.text,
      seq: row.seq,
      createdAt: row.created_at,
      clientNoteId: row.client_note_id,
    }));
  }
}

interface SnapshotRow {
  id: string;
  created_at: number;
  label_a: string;
  label_b: string;
  cursor_a: string;
  cursor_b: string;
  digest_a: string;
  digest_b: string;
  diff: string;
  notes: string;
  sealed: number;
}

function rowToSnapshot(row: SnapshotRow): IncidentSnapshot {
  return {
    contractVersion: 1,
    id: row.id,
    createdAt: row.created_at,
    labelA: row.label_a,
    labelB: row.label_b,
    cursorA: JSON.parse(row.cursor_a) as IncidentSnapshot["cursorA"],
    cursorB: JSON.parse(row.cursor_b) as IncidentSnapshot["cursorB"],
    digestA: JSON.parse(row.digest_a) as IncidentSnapshot["digestA"],
    digestB: JSON.parse(row.digest_b) as IncidentSnapshot["digestB"],
    diff: JSON.parse(row.diff) as IncidentSnapshot["diff"],
    notes: row.notes,
    sealed: true,
  };
}

interface SessionRow {
  id: string;
  anchor_snapshot_id: string;
  anchor_digest_a: string;
  anchor_digest_b: string;
  lease_leader_id: string | null;
  lease_leader_name: string | null;
  lease_fencing_token: number | null;
  lease_acquired_at: number | null;
  lease_expires_at: number | null;
  shared_cursor: string | null;
  snapshot_ids: string;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  participant_id: string;
  participant_name: string;
  text: string;
  seq: number;
  client_note_id: string;
  created_at: number;
}

export function rowToSession(
  row: SessionRow,
  notes: SessionNoteEntry[],
): InvestigationSession {
  const lease: FencingToken | null =
    row.lease_leader_id && row.lease_fencing_token != null
      ? {
          token: row.lease_fencing_token,
          leaderId: row.lease_leader_id,
          leaderName: row.lease_leader_name ?? row.lease_leader_id,
          acquiredAt: row.lease_acquired_at ?? 0,
          expiresAt: row.lease_expires_at ?? 0,
        }
      : null;
  return {
    contractVersion: 1,
    id: row.id,
    anchorSnapshotId: row.anchor_snapshot_id,
    anchorDigestA: row.anchor_digest_a,
    anchorDigestB: row.anchor_digest_b,
    lease,
    sharedCursor: row.shared_cursor
      ? (JSON.parse(row.shared_cursor) as SharedCursor)
      : null,
    notes,
    snapshotIds: JSON.parse(row.snapshot_ids) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
