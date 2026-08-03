import { EventEmitter } from 'node:events';
import type {
  LeaseError,
  LeaseState,
  ReplayCursor,
  SessionNote,
} from '../shared/contracts.js';
import type { SessionStore } from './sessionStore.js';

export interface AcquireResult {
  ok: boolean;
  lease: LeaseState | null;
  error: LeaseError | null;
  acquired: boolean;
}

export type SessionListener =
  | { kind: 'lease'; lease: LeaseState | null; reason: string }
  | { kind: 'cursor'; cursor: ReplayCursor; fencingToken: number; byClientId: string }
  | { kind: 'notes'; notes: SessionNote[] };

export class SessionService {
  private readonly store: SessionStore;
  private readonly clock: () => number;
  private readonly emitter: EventEmitter;
  private readonly defaultTtlMs = 30_000;

  constructor(store: SessionStore, clock: () => number = () => Date.now()) {
    this.store = store;
    this.clock = clock;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.sweepExpired();
  }

  getLease(): LeaseState | null {
    this.sweepExpired();
    return this.store.getLease();
  }

  getSharedCursor(): ReplayCursor {
    return this.store.getSharedCursor();
  }

  getNotes(): SessionNote[] {
    return this.store.listNotes();
  }

  acquire(clientId: string, clientName: string, ttlMs: number = this.defaultTtlMs): AcquireResult {
    const now = this.clock();
    this.sweepExpired(now);
    const existing = this.store.getLease();

    if (existing && existing.holderClientId !== clientId && existing.expiresAt > now) {
      return {
        ok: false,
        lease: existing,
        acquired: false,
        error: this.makeError('LEASE_HELD', `lease held by ${existing.holderName}`, existing),
      };
    }

    const currentCursor = existing?.sharedCursor ?? this.store.getSharedCursor();
    const { lease, acquired } = this.store.acquireLease(clientId, clientName, ttlMs, now, currentCursor);
    this.emitter.emit('session', { kind: 'lease', lease, reason: acquired ? 'acquired' : 'renewed' } satisfies SessionListener);
    return { ok: true, lease, error: null, acquired };
  }

  renew(clientId: string, fencingToken: number, ttlMs: number = this.defaultTtlMs): AcquireResult {
    const now = this.clock();
    this.sweepExpired(now);
    const lease = this.store.getLease();

    if (!lease || lease.holderClientId !== clientId) {
      return {
        ok: false,
        lease,
        acquired: false,
        error: this.makeError('NOT_LEADER', 'client is not the lease holder', lease),
      };
    }
    if (lease.fencingToken !== fencingToken) {
      return {
        ok: false,
        lease,
        acquired: false,
        error: this.makeError('STALE_FENCING', `stale fencing token ${fencingToken}, current is ${lease.fencingToken}`, lease),
      };
    }
    if (lease.expiresAt <= now) {
      return {
        ok: false,
        lease: null,
        acquired: false,
        error: this.makeError('LEASE_EXPIRED', 'lease expired, another client may take over', null),
      };
    }

    this.store.renewLease(fencingToken, ttlMs, now);
    const renewed = this.store.getLease();
    this.emitter.emit('session', { kind: 'lease', lease: renewed, reason: 'renewed' } satisfies SessionListener);
    return { ok: true, lease: renewed, error: null, acquired: false };
  }

  release(clientId: string, fencingToken: number): boolean {
    const lease = this.store.getLease();
    if (!lease || lease.holderClientId !== clientId || lease.fencingToken !== fencingToken) {
      return false;
    }
    this.store.releaseLease(fencingToken);
    this.emitter.emit('session', { kind: 'lease', lease: null, reason: 'released' } satisfies SessionListener);
    return true;
  }

  validateFencing(clientId: string | null, fencingToken: number | null | undefined): LeaseError | null {
    this.sweepExpired();
    if (fencingToken === null || fencingToken === undefined) {
      const lease = this.store.getLease();
      if (lease) {
        return this.makeError('NOT_LEADER', 'a lease is active; a valid fencing token is required', lease);
      }
      return null;
    }
    const lease = this.store.getLease();
    if (!lease) {
      return {
        code: 'LEASE_EXPIRED',
        message: 'no active lease; acquire one to mutate',
        currentFencingToken: this.store.getFencingToken(),
        currentHolder: null,
        expiresAt: null,
      };
    }
    if (lease.fencingToken !== fencingToken) {
      return this.makeError('STALE_FENCING', `fencing token ${fencingToken} is stale; current is ${lease.fencingToken}`, lease);
    }
    if (clientId !== null && lease.holderClientId !== clientId) {
      return this.makeError('NOT_LEADER', `lease held by ${lease.holderName}`, lease);
    }
    return null;
  }

  advanceCursor(clientId: string, fencingToken: number, cursor: ReplayCursor): { ok: boolean; error: LeaseError | null } {
    const err = this.validateFencing(clientId, fencingToken);
    if (err) return { ok: false, error: err };
    const updated = this.store.advanceCursor(fencingToken, cursor);
    if (!updated) {
      return { ok: false, error: this.makeError('STALE_FENCING', 'cursor update rejected: fencing token changed during write', this.store.getLease()) };
    }
    this.emitter.emit('session', { kind: 'cursor', cursor, fencingToken, byClientId: clientId } satisfies SessionListener);
    return { ok: true, error: null };
  }

  addNote(input: Omit<SessionNote, 'createdAt'> & { createdAt?: number }): { note: SessionNote; isNew: boolean } {
    const note: SessionNote = {
      clientId: input.clientId,
      clientSeq: input.clientSeq,
      authorName: input.authorName,
      text: input.text,
      snapshotId: input.snapshotId,
      createdAt: input.createdAt ?? this.clock(),
    };
    const isNew = this.store.addNote(note);
    if (isNew) {
      this.emitter.emit('session', { kind: 'notes', notes: [note] } satisfies SessionListener);
    }
    return { note, isNew };
  }

  subscribe(listener: (event: SessionListener) => void): () => void {
    this.emitter.on('session', listener);
    return () => { this.emitter.off('session', listener); };
  }

  close(): void {
    this.emitter.removeAllListeners();
  }

  private sweepExpired(now: number = this.clock()): void {
    const lease = this.store.getLease();
    if (lease && lease.expiresAt <= now) {
      this.store.releaseLease(lease.fencingToken);
      this.emitter.emit('session', { kind: 'lease', lease: null, reason: 'expired' } satisfies SessionListener);
    }
  }

  private makeError(code: LeaseError['code'], message: string, lease: LeaseState | null): LeaseError {
    return {
      code,
      message,
      currentFencingToken: lease?.fencingToken ?? this.store.getFencingToken(),
      currentHolder: lease?.holderClientId ?? null,
      expiresAt: lease?.expiresAt ?? null,
    };
  }
}
