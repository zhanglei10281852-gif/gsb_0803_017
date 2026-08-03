import type Database from 'better-sqlite3';
import type { LeaseState, ReplayCursor, SessionNote } from '../shared/contracts.js';
import { emptyHead } from '../shared/contracts.js';

interface LeaseRow {
  fencing_token: number;
  holder_client_id: string | null;
  holder_name: string | null;
  acquired_at: number | null;
  expires_at: number | null;
  cursor_event_time: number;
  cursor_ingest_sequence: number;
}

interface NoteRow {
  client_id: string;
  client_seq: number;
  author_name: string;
  text: string;
  snapshot_id: string | null;
  created_at: number;
}

export class SessionStore {
  private readonly db: Database.Database;
  private readonly getLeaseStmt: Database.Statement<[]>;
  private readonly insertLeaseIfEmptyStmt: Database.Statement<[number, number]>;
  private readonly acquireLeaseStmt: Database.Statement<[
    number, string, string, number, number, number, number,
  ]>;
  private readonly renewLeaseStmt: Database.Statement<[number, number]>;
  private readonly clearLeaseStmt: Database.Statement<[number]>;
  private readonly updateCursorStmt: Database.Statement<[number, number, number]>;
  private readonly insertNoteStmt: Database.Statement<[
    string, number, string, string, string | null, number,
  ]>;
  private readonly listNotesStmt: Database.Statement<[]>;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        fencing_token INTEGER NOT NULL DEFAULT 0,
        holder_client_id TEXT,
        holder_name TEXT,
        acquired_at INTEGER,
        expires_at INTEGER,
        cursor_event_time INTEGER NOT NULL DEFAULT 0,
        cursor_ingest_sequence INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_notes (
        client_id TEXT NOT NULL,
        client_seq INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        text TEXT NOT NULL,
        snapshot_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, client_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_notes_snapshot ON session_notes(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created ON session_notes(created_at, client_id, client_seq);
    `);

    this.insertLeaseIfEmptyStmt = this.db.prepare(
      `INSERT OR IGNORE INTO session_lease (id, fencing_token, cursor_event_time, cursor_ingest_sequence)
       VALUES (1, 0, ?, ?)`,
    );
    this.insertLeaseIfEmptyStmt.run(0, 0);

    this.getLeaseStmt = this.db.prepare('SELECT * FROM session_lease WHERE id = 1');
    this.acquireLeaseStmt = this.db.prepare(
      `UPDATE session_lease
       SET fencing_token = ?, holder_client_id = ?, holder_name = ?,
           acquired_at = ?, expires_at = ?,
           cursor_event_time = ?, cursor_ingest_sequence = ?
       WHERE id = 1`,
    );
    this.renewLeaseStmt = this.db.prepare(
      `UPDATE session_lease SET expires_at = ? WHERE id = 1 AND fencing_token = ?`,
    );
    this.clearLeaseStmt = this.db.prepare(
      `UPDATE session_lease
       SET holder_client_id = NULL, holder_name = NULL, acquired_at = NULL, expires_at = NULL
       WHERE id = 1 AND fencing_token = ?`,
    );
    this.updateCursorStmt = this.db.prepare(
      `UPDATE session_lease SET cursor_event_time = ?, cursor_ingest_sequence = ?
       WHERE id = 1 AND fencing_token = ?`,
    );
    this.insertNoteStmt = this.db.prepare(
      `INSERT OR IGNORE INTO session_notes
        (client_id, client_seq, author_name, text, snapshot_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.listNotesStmt = this.db.prepare(
      `SELECT * FROM session_notes
       ORDER BY created_at ASC, client_id ASC, client_seq ASC`,
    );
  }

  getLease(): LeaseState | null {
    const row = this.getLeaseStmt.get() as LeaseRow;
    if (!row.holder_client_id || !row.holder_name || row.acquired_at === null || row.expires_at === null) {
      return null;
    }
    return this.rowToLease(row);
  }

  getSharedCursor(): ReplayCursor {
    const row = this.getLeaseStmt.get() as LeaseRow;
    if (row.cursor_event_time === 0 && row.cursor_ingest_sequence === 0) {
      return emptyHead();
    }
    return {
      eventTime: row.cursor_event_time,
      ingestSequence: row.cursor_ingest_sequence,
    };
  }

  getFencingToken(): number {
    const row = this.getLeaseStmt.get() as LeaseRow;
    return row.fencing_token;
  }

  acquireLease(
    clientId: string,
    clientName: string,
    ttlMs: number,
    now: number,
    sharedCursor: ReplayCursor,
  ): { lease: LeaseState; token: number; acquired: boolean } {
    const current = this.getLeaseRow();
    const currentToken = current.fencing_token;
    const sameHolder = current.holder_client_id === clientId && current.expires_at !== null && current.expires_at > now;
    const newToken = sameHolder ? currentToken : currentToken + 1;
    const expiresAt = now + ttlMs;

    this.acquireLeaseStmt.run(
      newToken,
      clientId,
      clientName,
      now,
      expiresAt,
      sharedCursor.eventTime,
      sharedCursor.ingestSequence,
    );
    const row = this.getLeaseRow();
    return { lease: this.rowToLease(row)!, token: newToken, acquired: !sameHolder };
  }

  renewLease(fencingToken: number, ttlMs: number, now: number): boolean {
    const info = this.renewLeaseStmt.run(now + ttlMs, fencingToken);
    return info.changes > 0;
  }

  releaseLease(fencingToken: number): boolean {
    const info = this.clearLeaseStmt.run(fencingToken);
    return info.changes > 0;
  }

  advanceCursor(fencingToken: number, cursor: ReplayCursor): boolean {
    const info = this.updateCursorStmt.run(cursor.eventTime, cursor.ingestSequence, fencingToken);
    return info.changes > 0;
  }

  addNote(note: SessionNote): boolean {
    const info = this.insertNoteStmt.run(
      note.clientId,
      note.clientSeq,
      note.authorName,
      note.text,
      note.snapshotId,
      note.createdAt,
    );
    return info.changes > 0;
  }

  listNotes(): SessionNote[] {
    const rows = this.listNotesStmt.all() as NoteRow[];
    return rows.map((r) => this.rowToNote(r));
  }

  private getLeaseRow(): LeaseRow {
    return this.getLeaseStmt.get() as LeaseRow;
  }

  private rowToLease(row: LeaseRow): LeaseState | null {
    if (!row.holder_client_id || !row.holder_name || row.acquired_at === null || row.expires_at === null) {
      return null;
    }
    return {
      fencingToken: row.fencing_token,
      holderClientId: row.holder_client_id,
      holderName: row.holder_name,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      sharedCursor: {
        eventTime: row.cursor_event_time,
        ingestSequence: row.cursor_ingest_sequence,
      },
    };
  }

  private rowToNote(row: NoteRow): SessionNote {
    return {
      clientId: row.client_id,
      clientSeq: row.client_seq,
      authorName: row.author_name,
      text: row.text,
      snapshotId: row.snapshot_id,
      createdAt: row.created_at,
    };
  }
}
