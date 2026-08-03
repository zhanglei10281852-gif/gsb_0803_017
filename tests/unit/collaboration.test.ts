import { describe, it, expect } from 'vitest';
import {
  mergeNotes,
  classifyRole,
  nextLamport,
  isLeaseActive,
  effectiveCursor,
} from '../../src/shared/collaboration';
import type { InvestigationNote, SessionState } from '../../src/shared/contract';
import { CONTRACT_VERSION } from '../../src/shared/contract';

function note(p: Partial<InvestigationNote> & Pick<InvestigationNote, 'id' | 'lamport'>): InvestigationNote {
  return {
    id: p.id,
    author: p.author ?? 'a',
    lamport: p.lamport,
    body: p.body ?? 'body',
    createdAtMs: p.createdAtMs ?? 0,
  };
}

function state(p: Partial<SessionState> = {}): SessionState {
  return {
    contractVersion: CONTRACT_VERSION,
    session: { id: 1, label: 's', anchorSnapshotId: 1, anchorDigest: 'd', createdAtMs: 0 },
    lease: p.lease ?? null,
    highestFencingToken: p.highestFencingToken ?? 0,
    sharedCursor: p.sharedCursor ?? { eventTimeMs: 100, ingestSequence: 5 },
    sharedCursorToken: p.sharedCursorToken ?? 0,
    notes: p.notes ?? [],
  };
}

describe('mergeNotes determinism', () => {
  it('is order-independent (union, sorted by lamport/author/id)', () => {
    const a = [note({ id: 'x', author: 'bob', lamport: 2 }), note({ id: 'y', author: 'amy', lamport: 1 })];
    const b = [note({ id: 'z', author: 'amy', lamport: 2 })];
    const forward = mergeNotes(a, b);
    const backward = mergeNotes(b, a);
    expect(forward.map((n) => n.id)).toEqual(backward.map((n) => n.id));
    // Deterministic total order: lamport asc, then author, then id.
    expect(forward.map((n) => `${n.lamport}:${n.author}:${n.id}`)).toEqual([
      '1:amy:y',
      '2:amy:z',
      '2:bob:x',
    ]);
  });

  it('is NOT last-writer-wins: concurrent notes both survive', () => {
    const merged = mergeNotes(
      [note({ id: 'n1', author: 'teamA', lamport: 3, body: 'A view' })],
      [note({ id: 'n2', author: 'teamB', lamport: 3, body: 'B view' })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((n) => n.body)).toContain('A view');
    expect(merged.map((n) => n.body)).toContain('B view');
  });

  it('dedupes an identical id idempotently, keeping the higher lamport', () => {
    const merged = mergeNotes(
      [note({ id: 'same', lamport: 1, body: 'old' })],
      [note({ id: 'same', lamport: 5, body: 'new' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toBe('new');
  });

  it('converges regardless of how batches are split', () => {
    const all = [
      note({ id: 'a', author: 'x', lamport: 1 }),
      note({ id: 'b', author: 'y', lamport: 2 }),
      note({ id: 'c', author: 'z', lamport: 2 }),
      note({ id: 'd', author: 'x', lamport: 4 }),
    ];
    const split1 = mergeNotes(mergeNotes([all[0]!], [all[2]!, all[1]!]), [all[3]!]);
    const split2 = mergeNotes([all[3]!, all[1]!], mergeNotes([all[2]!], [all[0]!]));
    expect(JSON.stringify(split1)).toEqual(JSON.stringify(split2));
  });
});

describe('nextLamport', () => {
  it('advances past the highest seen', () => {
    expect(nextLamport(0, [note({ id: 'a', lamport: 7 })])).toBe(8);
    expect(nextLamport(9, [note({ id: 'a', lamport: 3 })])).toBe(10);
  });
});

describe('isLeaseActive', () => {
  it('is false for null or expired leases', () => {
    expect(isLeaseActive(null, 100)).toBe(false);
    expect(isLeaseActive({ holder: 'h', fencingToken: 1, expiresAtMs: 100 }, 100)).toBe(false);
    expect(isLeaseActive({ holder: 'h', fencingToken: 1, expiresAtMs: 101 }, 100)).toBe(true);
  });
});

describe('classifyRole — the three UI states + owner', () => {
  const lease = (holder: string, token: number, exp: number) => ({ holder, fencingToken: token, expiresAtMs: exp });

  it('owner when holding the active lease with the current token', () => {
    const s = state({ lease: lease('me', 3, 1000), highestFencingToken: 3 });
    const role = classifyRole({ state: s, localHolder: 'me', localFencingToken: 3, followOwner: true, nowMs: 500 });
    expect(role).toBe('owner');
  });

  it('following when not owner and choosing to follow', () => {
    const s = state({ lease: lease('other', 2, 1000), highestFencingToken: 2 });
    const role = classifyRole({ state: s, localHolder: 'me', localFencingToken: null, followOwner: true, nowMs: 500 });
    expect(role).toBe('following');
  });

  it('independent when not owner and not following', () => {
    const s = state({ lease: lease('other', 2, 1000), highestFencingToken: 2 });
    const role = classifyRole({ state: s, localHolder: 'me', localFencingToken: null, followOwner: false, nowMs: 500 });
    expect(role).toBe('independent');
  });

  it('lost-lease when a newer holder/token superseded this client', () => {
    // This client had token 2, but token 5 now belongs to someone else.
    const s = state({ lease: lease('newOwner', 5, 1000), highestFencingToken: 5 });
    const role = classifyRole({ state: s, localHolder: 'me', localFencingToken: 2, followOwner: true, nowMs: 500 });
    expect(role).toBe('lost-lease');
  });

  it('lost-lease when this client’s own lease expired', () => {
    const s = state({ lease: lease('me', 2, 400), highestFencingToken: 2 });
    const role = classifyRole({ state: s, localHolder: 'me', localFencingToken: 2, followOwner: true, nowMs: 500 });
    expect(role).toBe('lost-lease');
  });
});

describe('effectiveCursor', () => {
  it('followers track the shared cursor; others use local', () => {
    const shared = { eventTimeMs: 200, ingestSequence: 9 };
    const local = { eventTimeMs: 50, ingestSequence: 2 };
    expect(effectiveCursor({ role: 'following', followOwner: true, sharedCursor: shared, localCursor: local })).toEqual(shared);
    expect(effectiveCursor({ role: 'independent', followOwner: false, sharedCursor: shared, localCursor: local })).toEqual(local);
    expect(effectiveCursor({ role: 'owner', followOwner: false, sharedCursor: shared, localCursor: local })).toEqual(local);
  });
});
