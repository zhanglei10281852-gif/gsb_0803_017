import {
  AcquireLeaseResponse,
  FencingToken,
  IncidentSnapshot,
  InvestigationSession,
  SessionNoteEntry,
  SharedCursor
} from '../shared/contracts';
import { LedgerStore, rowToSession } from './ledgerStore';
import { ReplayService } from './replayService';

const DEFAULT_LEASE_TTL_MS = 15_000;

export interface CreateSessionInput {
  anchorSnapshotId: string;
  participantId: string;
  participantName: string;
}

export interface AddNoteInput {
  sessionId: string;
  participantId: string;
  participantName: string;
  text: string;
  clientNoteId: string;
}

export class InvestigationService {
  constructor(
    private readonly ledger: LedgerStore,
    private readonly replay: ReplayService,
    private readonly leaseTtlMs: number = DEFAULT_LEASE_TTL_MS
  ) {}

  getSession(id: string): InvestigationSession | null {
    const row = this.ledger.getSessionRow(id);
    if (!row) return null;
    const notes = this.ledger.listSessionNotes(id);
    return rowToSession(row, notes);
  }

  createSession(input: CreateSessionInput, now: number = Date.now()): InvestigationSession {
    const anchor = this.replay.getSnapshot(input.anchorSnapshotId);
    if (!anchor) {
      throw new Error(`anchor snapshot ${input.anchorSnapshotId} not found`);
    }
    const existing = this.ledger.getSessionRow(input.anchorSnapshotId);
    if (existing) {
      return this.getSession(input.anchorSnapshotId)!;
    }
    const lease: FencingToken = {
      token: 1,
      leaderId: input.participantId,
      leaderName: input.participantName,
      acquiredAt: now,
      expiresAt: now + this.leaseTtlMs
    };
    const session: InvestigationSession = {
      contractVersion: 1,
      id: input.anchorSnapshotId,
      anchorSnapshotId: input.anchorSnapshotId,
      anchorDigestA: anchor.digestA.recordsDigest,
      anchorDigestB: anchor.digestB.recordsDigest,
      lease,
      sharedCursor: {
        cursor: anchor.cursorB,
        label: `anchor: ${anchor.labelB}`,
        updatedAt: now,
        updatedBy: input.participantId,
        snapshotId: anchor.id
      },
      notes: [],
      snapshotIds: [anchor.id],
      createdAt: now,
      updatedAt: now
    };
    this.ledger.saveSession(session);
    return session;
  }

  private isLeaseValid(lease: FencingToken | null, now: number): boolean {
    return Boolean(lease && lease.expiresAt > now);
  }

  acquireLease(
    sessionId: string,
    participantId: string,
    participantName: string,
    clientToken: number,
    now: number = Date.now()
  ): AcquireLeaseResponse {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const current = session.lease;

    if (
      current &&
      current.leaderId === participantId &&
      current.token === clientToken &&
      current.expiresAt > now
    ) {
      const renewed: FencingToken = { ...current, expiresAt: now + this.leaseTtlMs };
      this.ledger.updateLease(sessionId, renewed, now);
      return { ok: true, lease: renewed, reason: 'renewed' };
    }

    if (this.isLeaseValid(current, now)) {
      return { ok: false, lease: current, reason: 'rejected-active-lease' };
    }

    if (clientToken > 0 && current && clientToken <= current.token && current.leaderId !== participantId) {
      return { ok: false, lease: current, reason: 'stale-token' };
    }

    const nextToken = current ? current.token + 1 : 1;
    const lease: FencingToken = {
      token: nextToken,
      leaderId: participantId,
      leaderName: participantName,
      acquiredAt: now,
      expiresAt: now + this.leaseTtlMs
    };
    this.ledger.updateLease(sessionId, lease, now);
    return { ok: true, lease, reason: 'acquired' };
  }

  private authorizeLeader(
    session: InvestigationSession,
    participantId: string,
    fencingToken: number,
    now: number
  ): { ok: true; lease: FencingToken } | { ok: false; reason: string } {
    const lease = session.lease;
    if (!lease || lease.expiresAt <= now) {
      return { ok: false, reason: 'lease-expired' };
    }
    if (lease.leaderId !== participantId) {
      return { ok: false, reason: 'not-leader' };
    }
    if (fencingToken !== lease.token) {
      return { ok: false, reason: 'stale-fencing-token' };
    }
    return { ok: true, lease };
  }

  advanceSharedCursor(
    sessionId: string,
    participantId: string,
    fencingToken: number,
    cursor: SharedCursor['cursor'],
    label: string,
    snapshotId: string | null,
    now: number = Date.now()
  ): InvestigationSession {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const auth = this.authorizeLeader(session, participantId, fencingToken, now);
    if (!auth.ok) throw new Error(auth.reason);

    const shared: SharedCursor = {
      cursor,
      label,
      updatedAt: now,
      updatedBy: participantId,
      snapshotId
    };
    this.ledger.updateSharedCursor(sessionId, shared, now);
    return this.getSession(sessionId)!;
  }

  sealSnapshot(
    sessionId: string,
    participantId: string,
    fencingToken: number,
    cursor: SharedCursor['cursor'],
    label: string,
    notes: string,
    now: number = Date.now()
  ): { session: InvestigationSession; snapshot: IncidentSnapshot } {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const auth = this.authorizeLeader(session, participantId, fencingToken, now);
    if (!auth.ok) throw new Error(auth.reason);

    const anchor = this.replay.getSnapshot(session.anchorSnapshotId)!;
    const snapshot = this.replay.createSnapshot(
      {
        labelA: anchor.labelB,
        labelB: label,
        cursorA: anchor.cursorB,
        cursorB: cursor,
        notes
      },
      now
    );

    const snapshotIds = [...session.snapshotIds, snapshot.id];
    this.ledger.updateSessionSnapshotIds(sessionId, snapshotIds, now);
    const shared: SharedCursor = {
      cursor,
      label: `sealed: ${label}`,
      updatedAt: now,
      updatedBy: participantId,
      snapshotId: snapshot.id
    };
    this.ledger.updateSharedCursor(sessionId, shared, now);
    return { session: this.getSession(sessionId)!, snapshot };
  }

  addNote(input: AddNoteInput, now: number = Date.now()): {
    session: InvestigationSession;
    note: SessionNoteEntry;
    deduped: boolean;
  } {
    const session = this.getSession(input.sessionId);
    if (!session) throw new Error('session not found');

    const nextSeq = this.ledger.maxNoteSeq(input.sessionId) + 1;
    const note: SessionNoteEntry = {
      id: input.clientNoteId,
      participantId: input.participantId,
      participantName: input.participantName,
      text: input.text,
      seq: nextSeq,
      createdAt: now
    };
    const inserted = this.ledger.addSessionNote(input.sessionId, note.id, {
      ...note,
      clientNoteId: input.clientNoteId
    });
    if (!inserted) {
      const refreshed = this.getSession(input.sessionId)!;
      const race = refreshed.notes.find((n) => n.id === input.clientNoteId);
      if (race) return { session: refreshed, note: race, deduped: true };
    }
    return { session: this.getSession(input.sessionId)!, note, deduped: !inserted };
  }

  mergeNotes(sessionId: string): readonly SessionNoteEntry[] {
    const notes = this.ledger.listSessionNotes(sessionId);
    return notes.slice().sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.id.localeCompare(b.id);
    });
  }
}
