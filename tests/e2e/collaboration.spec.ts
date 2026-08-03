import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, removeDirWithRetry, type RunningServer } from './server';
import { seedIncident } from './seed';

/**
 * Cross-shift collaboration E2E. Two browser contexts model two on-call teams
 * sharing one session anchored to a sealed snapshot. We drive the lease/fencing
 * via the real API (short TTLs make takeover-after-expiry deterministic) and
 * assert the UI's three participant states plus deterministic note merge.
 */
test.describe('cross-shift collaboration (two browsers + real server)', () => {
  // Two browser contexts + short lease expiry waits need a larger budget than
  // the default per-test timeout, especially late in the full suite run.
  test.setTimeout(120_000);
  let server: RunningServer;

  test.afterEach(async () => {
    if (server) await server.stop();
  });

  async function sealAnchor(baseUrl: string): Promise<{ id: number; digest: string }> {
    const bounds = (await (await fetch(`${baseUrl}/api/bounds`)).json()).bounds as {
      maxEventTimeMs: number;
      maxIngestSequence: number;
    };
    const res = await fetch(`${baseUrl}/api/snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'A',
        note: 'handoff anchor',
        cursor: { eventTimeMs: bounds.maxEventTimeMs, ingestSequence: bounds.maxIngestSequence },
      }),
    });
    const body = await res.json();
    return { id: body.snapshot.id, digest: body.snapshot.provenance.digest };
  }

  test('two shifts share a session; role badges reflect owner / following / lost-lease', async ({ browser }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    const anchor = await sealAnchor(server.baseUrl);

    // Create the session up front via API so both browsers can join it.
    const session = await (
      await fetch(`${server.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'handoff', anchorSnapshotId: anchor.id, anchorDigest: anchor.digest }),
      })
    ).json();
    const sid = session.session.id as number;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await joinSession(pageA, server.baseUrl, sid, 4000); // A: lease expires after 4s
    await joinSession(pageB, server.baseUrl, sid, 60000); // B: long lease, stays owner

    // A takes over as owner (the 4s window comfortably covers these assertions).
    await pageA.getByTestId('takeover-lease').click();
    await expect(pageA.getByTestId('role-badge')).toHaveAttribute('data-role', 'owner');

    // B, following by default, sees itself as a follower and A as the owner.
    await expect(pageB.getByTestId('role-badge')).toHaveAttribute('data-role', 'following');

    // B switches to independent viewing.
    await pageB.getByTestId('toggle-follow').click();
    await expect(pageB.getByTestId('role-badge')).toHaveAttribute('data-role', 'independent');

    // Wait for A's lease to expire, then B takes over. B's higher fencing token
    // supersedes A, so A — which still believes it held the lease — flips to
    // "lost-lease" and can no longer write.
    await pageB.waitForTimeout(4300);
    await pageB.getByTestId('takeover-lease').click();
    await expect(pageB.getByTestId('role-badge')).toHaveAttribute('data-role', 'owner');
    await expect(pageA.getByTestId('role-badge')).toHaveAttribute('data-role', 'lost-lease', { timeout: 15000 });

    // The fenced-out A cannot seal (button disabled with a lock note).
    await expect(pageA.getByTestId('seal-blocked')).toBeVisible();
    await expect(pageA.getByTestId('seal-snapshot')).toBeDisabled();

    await ctxA.close();
    await ctxB.close();
  });

  test('concurrent notes from both shifts converge to the same deterministic order', async ({ browser }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    const anchor = await sealAnchor(server.baseUrl);
    const session = await (
      await fetch(`${server.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'handoff', anchorSnapshotId: anchor.id, anchorDigest: anchor.digest }),
      })
    ).json();
    const sid = session.session.id as number;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await joinSession(pageA, server.baseUrl, sid);
    await joinSession(pageB, server.baseUrl, sid);

    // Both teams add notes concurrently (no lease needed for notes).
    await pageA.getByTestId('note-input').fill('A: suspect bank-connector');
    await pageA.getByTestId('add-note').click();
    await pageB.getByTestId('note-input').fill('B: payments correction matters');
    await pageB.getByTestId('add-note').click();

    // Both browsers must show both notes (union, not last-writer-wins).
    await expect(pageA.getByTestId('collab-notes')).toContainText('A: suspect bank-connector', { timeout: 15000 });
    await expect(pageA.getByTestId('collab-notes')).toContainText('B: payments correction matters', { timeout: 15000 });
    await expect(pageB.getByTestId('collab-notes')).toContainText('A: suspect bank-connector', { timeout: 15000 });
    await expect(pageB.getByTestId('collab-notes')).toContainText('B: payments correction matters', { timeout: 15000 });

    // The rendered order is identical on both clients (deterministic merge).
    const orderA = await noteOrder(pageA);
    const orderB = await noteOrder(pageB);
    expect(orderA).toEqual(orderB);

    await ctxA.close();
    await ctxB.close();
  });

  test('lease, fencing token and notes survive a server restart', async ({ browser }) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-collab-'));
    const dbPath = join(dir, 'ledger.sqlite');
    try {
      server = await startServer({ dbPath });
      await seedIncident(server.baseUrl);
      const anchor = await sealAnchor(server.baseUrl);
      const session = await (
        await fetch(`${server.baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'handoff', anchorSnapshotId: anchor.id, anchorDigest: anchor.digest }),
        })
      ).json();
      const sid = session.session.id as number;

      const ctxA = await browser.newContext();
      const pageA = await ctxA.newPage();
      await joinSession(pageA, server.baseUrl, sid, 30000); // long lease; no expiry race
      await pageA.getByTestId('takeover-lease').click();
      await expect(pageA.getByTestId('role-badge')).toHaveAttribute('data-role', 'owner');
      await pageA.getByTestId('note-input').fill('persist across restart');
      await pageA.getByTestId('add-note').click();
      await expect(pageA.getByTestId('collab-notes')).toContainText('persist across restart');

      // Capture lease state via API before restart.
      const before = await (await fetch(`${server.baseUrl}/api/sessions/${sid}`)).json();
      expect(before.lease).not.toBeNull();
      const tokenBefore = before.highestFencingToken as number;

      // Restart the server against the same DB (no re-ingest).
      await server.stop();
      server = await startServer({ dbPath });

      const after = await (await fetch(`${server.baseUrl}/api/sessions/${sid}`)).json();
      expect(after.highestFencingToken).toBe(tokenBefore);
      expect(after.lease).not.toBeNull(); // the lease itself survived the restart
      expect(after.notes.map((n: { body: string }) => n.body)).toContain('persist across restart');
      // The current holder (the UI's dispatcher identity) re-acquiring after
      // restart mints a strictly higher token — monotonic across restart, no
      // reliance on wall-clock expiry.
      const currentHolder = after.lease.holder as string;
      const acquiredRes = await fetch(`${server.baseUrl}/api/sessions/${sid}/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holder: currentHolder }),
      });
      const acquired = await acquiredRes.json();
      expect(acquiredRes.status, JSON.stringify(acquired)).toBe(201);
      expect(acquired.lease.fencingToken).toBeGreaterThan(tokenBefore);

      await ctxA.close();
    } finally {
      if (server) await server.stop();
      await removeDirWithRetry(dir);
    }
  });
});

async function joinSession(page: Page, baseUrl: string, sessionId: number, leaseTtlMs?: number): Promise<void> {
  const url = leaseTtlMs === undefined ? baseUrl : `${baseUrl}/?leaseTtlMs=${leaseTtlMs}`;
  await page.goto(url);
  await expect(page.getByTestId('collab-panel')).toBeVisible();
  await page.getByTestId('join-session-id').fill(String(sessionId));
  await page.getByTestId('join-session').click();
  await expect(page.getByTestId('collab-anchor')).toBeVisible();
}

async function noteOrder(page: Page): Promise<string[]> {
  return page.locator('[data-testid="collab-notes"] li .note-body').allInnerTexts();
}
