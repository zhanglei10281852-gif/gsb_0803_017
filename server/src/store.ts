import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  parseSpanEvent,
  type IncidentSnapshotV1,
  type LedgerEntryV1,
  type ReplayCursorV1,
  type SessionNoteV1,
  type SessionParticipantV1,
  type SnapshotDiffV1,
  type SnapshotListItemV1,
  type SnapshotNoteV1,
  type SpanEventV1,
  type IngestReceiptV1,
} from "@replay/shared";
import type { SessionNoteInput } from "@replay/shared";

export interface HeadInfo {
  cursor: ReplayCursorV1;
  totalEntries: number;
  distinctSpans: number;
  services: string[];
}

interface LedgerRow {
  ingest_sequence: number;
  received_at_ms: number;
  raw_json: string;
}

/**
 * SQLite 存储：
 * - ledger：追加式不可变原始账本（唯一真实来源），(producer_id, event_id) 幂等去重；
 * - projection_current：可重建投影（当前生效版本），启动时校验、失配自动重建。
 */
export class ReplayStore {
  private readonly db: Database.Database;
  private nextSeq: number;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    const row = this.db
      .prepare("SELECT COALESCE(MAX(ingest_sequence), 0) AS m FROM ledger")
      .get() as { m: number };
    this.nextSeq = row.m + 1;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger (
        ingest_sequence INTEGER PRIMARY KEY,
        producer_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        attributes_json TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        UNIQUE (producer_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_span ON ledger(trace_id, span_id, revision);
      CREATE INDEX IF NOT EXISTS idx_ledger_event_time ON ledger(event_time);
      CREATE TABLE IF NOT EXISTS projection_current (
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        ingest_sequence INTEGER NOT NULL,
        event_time INTEGER NOT NULL,
        service TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (trace_id, span_id)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        label TEXT,
        cursor_a TEXT NOT NULL,
        cursor_b TEXT NOT NULL,
        high_water TEXT NOT NULL,
        digest TEXT NOT NULL UNIQUE,
        diff_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_notes (
        note_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
      );
      CREATE INDEX IF NOT EXISTS idx_notes_snapshot ON snapshot_notes(snapshot_id);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        anchor_snapshot_id TEXT NOT NULL,
        anchor_digest TEXT NOT NULL,
        label TEXT,
        created_at_ms INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        shared_cursor TEXT NOT NULL,
        fencing_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_leases (
        session_id TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        holder_name TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, client_id)
      );
      CREATE TABLE IF NOT EXISTS session_notes (
        session_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at_ms REAL NOT NULL,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        UNIQUE (session_id, note_id)
      );
      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        sealed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, snapshot_id)
      );
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
    `);
  }

  /** 事务内写入：单调 ingestSequence + 幂等去重 + 增量投影。 */
  ingestBatch(events: readonly SpanEventV1[]): {
    receipts: IngestReceiptV1[];
    accepted: LedgerEntryV1[];
  } {
    const findDup = this.db.prepare(
      "SELECT ingest_sequence AS seq FROM ledger WHERE producer_id = ? AND event_id = ?",
    );
    const insert = this.db.prepare(`
      INSERT INTO ledger (
        ingest_sequence, producer_id, event_id, trace_id, span_id, parent_span_id,
        service, operation, event_time, duration_ms, revision, status, error_message,
        attributes_json, received_at_ms, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getCurrent = this.db.prepare(
      "SELECT revision AS r FROM projection_current WHERE trace_id = ? AND span_id = ?",
    );
    const upsertCurrent = this.db.prepare(`
      INSERT INTO projection_current (trace_id, span_id, revision, ingest_sequence, event_time, service, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id, span_id) DO UPDATE SET
        revision = excluded.revision,
        ingest_sequence = excluded.ingest_sequence,
        event_time = excluded.event_time,
        service = excluded.service,
        status = excluded.status
    `);

    const receipts: IngestReceiptV1[] = [];
    const accepted: LedgerEntryV1[] = [];
    const tx = this.db.transaction((batch: readonly SpanEventV1[]) => {
      for (const ev of batch) {
        const dup = findDup.get(ev.producerId, ev.eventId) as { seq: number } | undefined;
        if (dup) {
          receipts.push({
            contract: "ingest-receipt/1",
            producerId: ev.producerId,
            eventId: ev.eventId,
            ingestSequence: dup.seq,
            outcome: "duplicate",
          });
          continue;
        }
        const seq = this.nextSeq;
        this.nextSeq += 1;
        const receivedAt = Date.now();
        insert.run(
          seq,
          ev.producerId,
          ev.eventId,
          ev.traceId,
          ev.spanId,
          ev.parentSpanId,
          ev.service,
          ev.operation,
          ev.eventTime,
          ev.durationMs,
          ev.revision,
          ev.status,
          ev.errorMessage,
          JSON.stringify(ev.attributes),
          receivedAt,
          JSON.stringify(ev),
        );
        const cur = getCurrent.get(ev.traceId, ev.spanId) as { r: number } | undefined;
        if (!cur || ev.revision > cur.r) {
          upsertCurrent.run(ev.traceId, ev.spanId, ev.revision, seq, ev.eventTime, ev.service, ev.status);
        }
        accepted.push({
          contract: "ledger-entry/1",
          ingestSequence: seq,
          receivedAtMs: receivedAt,
          event: ev,
        });
        receipts.push({
          contract: "ingest-receipt/1",
          producerId: ev.producerId,
          eventId: ev.eventId,
          ingestSequence: seq,
          outcome: "accepted",
        });
      }
    });
    tx(events);
    return { receipts, accepted };
  }

  private rowToEntry(row: unknown): LedgerEntryV1 {
    const r = row as LedgerRow;
    const parsed = parseSpanEvent(JSON.parse(r.raw_json));
    if (!parsed.ok) {
      throw new Error(`账本行 ${r.ingest_sequence} 数据损坏：${parsed.error}`);
    }
    return {
      contract: "ledger-entry/1",
      ingestSequence: r.ingest_sequence,
      receivedAtMs: r.received_at_ms,
      event: parsed.value,
    };
  }

  entriesSince(since: number, limit = 50_000): LedgerEntryV1[] {
    const rows = this.db
      .prepare("SELECT ingest_sequence, received_at_ms, raw_json FROM ledger WHERE ingest_sequence > ? ORDER BY ingest_sequence ASC LIMIT ?")
      .all(since, limit);
    return rows.map((r) => this.rowToEntry(r));
  }

  allEntries(): LedgerEntryV1[] {
    const rows = this.db
      .prepare("SELECT ingest_sequence, received_at_ms, raw_json FROM ledger ORDER BY ingest_sequence ASC")
      .all();
    return rows.map((r) => this.rowToEntry(r));
  }

  spanVersions(traceId: string, spanId: string): LedgerEntryV1[] {
    const rows = this.db
      .prepare("SELECT ingest_sequence, received_at_ms, raw_json FROM ledger WHERE trace_id = ? AND span_id = ? ORDER BY ingest_sequence ASC")
      .all(traceId, spanId);
    return rows.map((r) => this.rowToEntry(r));
  }

  head(): HeadInfo {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(ingest_sequence), 0) AS seq, COALESCE(MAX(event_time), 0) AS t, COUNT(*) AS n FROM ledger")
      .get() as { seq: number; t: number; n: number };
    const spans = this.db
      .prepare("SELECT COUNT(*) AS c FROM (SELECT 1 FROM ledger GROUP BY trace_id, span_id)")
      .get() as { c: number };
    const services = (
      this.db.prepare("SELECT DISTINCT service FROM ledger ORDER BY service").all() as Array<{ service: string }>
    ).map((x) => x.service);
    return {
      cursor: { contract: "replay-cursor/1", eventTime: r.t, ingestSequence: r.seq },
      totalEntries: r.n,
      distinctSpans: spans.c,
      services,
    };
  }

  projectionChecksum(): string {
    const rows = this.db
      .prepare("SELECT trace_id, span_id, revision, ingest_sequence FROM projection_current ORDER BY trace_id, span_id")
      .all() as Array<{ trace_id: string; span_id: string; revision: number; ingest_sequence: number }>;
    const h = createHash("sha256");
    for (const r of rows) {
      h.update(`${r.trace_id}|${r.span_id}|${r.revision}|${r.ingest_sequence}\n`);
    }
    return h.digest("hex");
  }

  /** 从账本全量重建投影（投影是派生物，随时可丢弃重建）。 */
  rebuildProjection(): { rows: number; checksum: string } {
    interface Row {
      trace_id: string;
      span_id: string;
      revision: number;
      ingest_sequence: number;
      event_time: number;
      service: string;
      status: string;
    }
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM projection_current").run();
      const rows = this.db
        .prepare("SELECT trace_id, span_id, revision, ingest_sequence, event_time, service, status FROM ledger ORDER BY ingest_sequence ASC")
        .all() as Row[];
      const current = new Map<string, Row>();
      for (const r of rows) {
        const key = `${r.trace_id} ${r.span_id}`;
        const existing = current.get(key);
        if (!existing || r.revision > existing.revision) current.set(key, r);
      }
      const ins = this.db.prepare(
        "INSERT INTO projection_current (trace_id, span_id, revision, ingest_sequence, event_time, service, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of current.values()) {
        ins.run(r.trace_id, r.span_id, r.revision, r.ingest_sequence, r.event_time, r.service, r.status);
      }
    });
    tx();
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM projection_current").get() as { c: number };
    return { rows: count.c, checksum: this.projectionChecksum() };
  }

  /** 启动自检：增量投影与账本重建结果比对，失配则以账本为准重建。 */
  verifyProjection(): { ok: boolean; rebuilt: boolean; checksum: string } {
    const before = this.projectionChecksum();
    const rebuilt = this.rebuildProjection();
    return { ok: before === rebuilt.checksum, rebuilt: before !== rebuilt.checksum, checksum: rebuilt.checksum };
  }

  close(): void {
    this.db.close();
  }

  /* ---------- IncidentSnapshot：追加式、不可改写的封存结果 ---------- */

  saveSnapshot(s: IncidentSnapshotV1): { existing: boolean } {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO snapshots (id, created_at_ms, label, cursor_a, cursor_b, high_water, digest, diff_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.createdAtMs,
        s.label,
        JSON.stringify(s.cursorA),
        JSON.stringify(s.cursorB),
        JSON.stringify(s.highWater),
        s.digest,
        JSON.stringify(s.diff),
      );
    return { existing: res.changes === 0 };
  }

  getSnapshot(id: string): IncidentSnapshotV1 | null {
    const row = this.db
      .prepare("SELECT id, created_at_ms, label, cursor_a, cursor_b, high_water, digest, diff_json FROM snapshots WHERE id = ?")
      .get(id) as
      | {
          id: string;
          created_at_ms: number;
          label: string | null;
          cursor_a: string;
          cursor_b: string;
          high_water: string;
          digest: string;
          diff_json: string;
        }
      | undefined;
    if (!row) return null;
    const notes = this.db
      .prepare("SELECT note_id, created_at_ms, author, text FROM snapshot_notes WHERE snapshot_id = ? ORDER BY created_at_ms ASC, rowid ASC")
      .all(id) as Array<{ note_id: string; created_at_ms: number; author: string; text: string }>;
    return {
      contract: "incident-snapshot/1",
      id: row.id,
      label: row.label,
      cursorA: JSON.parse(row.cursor_a) as ReplayCursorV1,
      cursorB: JSON.parse(row.cursor_b) as ReplayCursorV1,
      highWater: JSON.parse(row.high_water) as IncidentSnapshotV1["highWater"],
      digest: row.digest,
      createdAtMs: row.created_at_ms,
      diff: JSON.parse(row.diff_json) as SnapshotDiffV1,
      notes: notes.map((n) => ({
        contract: "snapshot-note/1",
        noteId: n.note_id,
        createdAtMs: n.created_at_ms,
        author: n.author,
        text: n.text,
      })),
    };
  }

  listSnapshots(): SnapshotListItemV1[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.label, s.cursor_a, s.cursor_b, s.digest, s.created_at_ms, s.diff_json,
                (SELECT COUNT(*) FROM snapshot_notes n WHERE n.snapshot_id = s.id) AS note_count
         FROM snapshots s ORDER BY s.created_at_ms DESC, s.id DESC`,
      )
      .all() as Array<{
      id: string;
      label: string | null;
      cursor_a: string;
      cursor_b: string;
      digest: string;
      created_at_ms: number;
      diff_json: string;
      note_count: number;
    }>;
    return rows.map((r) => ({
      contract: "snapshot-item/1",
      id: r.id,
      label: r.label,
      cursorA: JSON.parse(r.cursor_a) as ReplayCursorV1,
      cursorB: JSON.parse(r.cursor_b) as ReplayCursorV1,
      digest: r.digest,
      createdAtMs: r.created_at_ms,
      noteCount: r.note_count,
      summary: (JSON.parse(r.diff_json) as SnapshotDiffV1).summary,
    }));
  }

  addNote(snapshotId: string, author: string, text: string): SnapshotNoteV1 | null {
    const exists = this.db.prepare("SELECT 1 AS x FROM snapshots WHERE id = ?").get(snapshotId);
    if (!exists) return null;
    const note: SnapshotNoteV1 = {
      contract: "snapshot-note/1",
      noteId: `note-${randomUUID()}`,
      createdAtMs: Date.now(),
      author,
      text,
    };
    this.db
      .prepare("INSERT INTO snapshot_notes (note_id, snapshot_id, created_at_ms, author, text) VALUES (?, ?, ?, ?, ?)")
      .run(note.noteId, snapshotId, note.createdAtMs, note.author, note.text);
    return note;
  }

  /* ---------- InvestigationSession：会话 / 租约 / 参与者 / 备注 / 会话快照 ---------- */

  createSessionRow(row: {
    sessionId: string;
    anchorSnapshotId: string;
    anchorDigest: string;
    label: string | null;
    createdAtMs: number;
    createdBy: string;
    sharedCursor: ReplayCursorV1;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, anchor_snapshot_id, anchor_digest, label, created_at_ms, created_by, shared_cursor, fencing_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        row.sessionId,
        row.anchorSnapshotId,
        row.anchorDigest,
        row.label,
        row.createdAtMs,
        row.createdBy,
        JSON.stringify(row.sharedCursor),
      );
  }

  getSessionRow(sessionId: string):
    | {
        session_id: string;
        anchor_snapshot_id: string;
        anchor_digest: string;
        label: string | null;
        created_at_ms: number;
        created_by: string;
        shared_cursor: string;
        fencing_seq: number;
      }
    | undefined {
    return this.db
      .prepare(
        "SELECT session_id, anchor_snapshot_id, anchor_digest, label, created_at_ms, created_by, shared_cursor, fencing_seq FROM sessions WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          session_id: string;
          anchor_snapshot_id: string;
          anchor_digest: string;
          label: string | null;
          created_at_ms: number;
          created_by: string;
          shared_cursor: string;
          fencing_seq: number;
        }
      | undefined;
  }

  listSessionRows(): Array<{
    session_id: string;
    anchor_snapshot_id: string;
    anchor_digest: string;
    label: string | null;
    created_at_ms: number;
    created_by: string;
  }> {
    return this.db
      .prepare(
        "SELECT session_id, anchor_snapshot_id, anchor_digest, label, created_at_ms, created_by FROM sessions ORDER BY created_at_ms DESC",
      )
      .all() as Array<{
      session_id: string;
      anchor_snapshot_id: string;
      anchor_digest: string;
      label: string | null;
      created_at_ms: number;
      created_by: string;
    }>;
  }

  updateSharedCursor(sessionId: string, cursor: ReplayCursorV1): void {
    this.db
      .prepare("UPDATE sessions SET shared_cursor = ? WHERE session_id = ?")
      .run(JSON.stringify(cursor), sessionId);
  }

  /** fencing token 持久化单调递增：每次授租取下一个值。 */
  nextFencingToken(sessionId: string): number {
    this.db
      .prepare("UPDATE sessions SET fencing_seq = fencing_seq + 1 WHERE session_id = ?")
      .run(sessionId);
    const row = this.db
      .prepare("SELECT fencing_seq AS f FROM sessions WHERE session_id = ?")
      .get(sessionId) as { f: number };
    return row.f;
  }

  getLease(sessionId: string):
    | {
        holder_id: string;
        holder_name: string;
        fencing_token: number;
        acquired_at_ms: number;
        expires_at_ms: number;
        ttl_ms: number;
      }
    | undefined {
    return this.db
      .prepare(
        "SELECT holder_id, holder_name, fencing_token, acquired_at_ms, expires_at_ms, ttl_ms FROM session_leases WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          holder_id: string;
          holder_name: string;
          fencing_token: number;
          acquired_at_ms: number;
          expires_at_ms: number;
          ttl_ms: number;
        }
      | undefined;
  }

  setLease(
    sessionId: string,
    lease: {
      holderId: string;
      holderName: string;
      fencingToken: number;
      acquiredAtMs: number;
      expiresAtMs: number;
      ttlMs: number;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_leases (session_id, holder_id, holder_name, fencing_token, acquired_at_ms, expires_at_ms, ttl_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           holder_id = excluded.holder_id,
           holder_name = excluded.holder_name,
           fencing_token = excluded.fencing_token,
           acquired_at_ms = excluded.acquired_at_ms,
           expires_at_ms = excluded.expires_at_ms,
           ttl_ms = excluded.ttl_ms`,
      )
      .run(
        sessionId,
        lease.holderId,
        lease.holderName,
        lease.fencingToken,
        lease.acquiredAtMs,
        lease.expiresAtMs,
        lease.ttlMs,
      );
  }

  clearLease(sessionId: string): void {
    this.db.prepare("DELETE FROM session_leases WHERE session_id = ?").run(sessionId);
  }

  upsertParticipant(sessionId: string, clientId: string, name: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO session_participants (session_id, client_id, name, joined_at_ms, last_seen_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, client_id) DO UPDATE SET name = excluded.name, last_seen_ms = excluded.last_seen_ms`,
      )
      .run(sessionId, clientId, name, nowMs, nowMs);
  }

  listParticipants(sessionId: string): SessionParticipantV1[] {
    const rows = this.db
      .prepare(
        "SELECT client_id, name, joined_at_ms, last_seen_ms FROM session_participants WHERE session_id = ? ORDER BY joined_at_ms ASC, client_id ASC",
      )
      .all(sessionId) as Array<{ client_id: string; name: string; joined_at_ms: number; last_seen_ms: number }>;
    return rows.map((r) => ({
      clientId: r.client_id,
      name: r.name,
      joinedAtMs: r.joined_at_ms,
      lastSeenMs: r.last_seen_ms,
    }));
  }

  /** 备注幂等写入（客户端重试不产生重复），归并排序在查询侧完成。 */
  insertSessionNote(sessionId: string, note: SessionNoteInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_notes (session_id, note_id, client_id, author, text, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, note.noteId, note.clientId, note.author, note.text, note.createdAtMs);
  }

  /** 确定性归并：按 (createdAtMs, clientId, noteId) 全序，与到达顺序无关。 */
  listSessionNotes(sessionId: string): SessionNoteV1[] {
    const rows = this.db
      .prepare(
        `SELECT note_id, client_id, author, text, created_at_ms, seq FROM session_notes
         WHERE session_id = ? ORDER BY created_at_ms ASC, client_id ASC, note_id ASC`,
      )
      .all(sessionId) as Array<{
      note_id: string;
      client_id: string;
      author: string;
      text: string;
      created_at_ms: number;
      seq: number;
    }>;
    return rows.map((r) => ({
      noteId: r.note_id,
      clientId: r.client_id,
      author: r.author,
      text: r.text,
      createdAtMs: r.created_at_ms,
      seq: r.seq,
    }));
  }

  countSessionNotes(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM session_notes WHERE session_id = ?")
      .get(sessionId) as { c: number };
    return row.c;
  }

  linkSessionSnapshot(sessionId: string, snapshotId: string, sealedAtMs: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO session_snapshots (session_id, snapshot_id, sealed_at_ms) VALUES (?, ?, ?)",
      )
      .run(sessionId, snapshotId, sealedAtMs);
  }

  listSessionSnapshotIds(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT snapshot_id FROM session_snapshots WHERE session_id = ? ORDER BY sealed_at_ms ASC, snapshot_id ASC",
      )
      .all(sessionId) as Array<{ snapshot_id: string }>;
    return rows.map((r) => r.snapshot_id);
  }
}
