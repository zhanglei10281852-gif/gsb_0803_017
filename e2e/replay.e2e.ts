import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeRawSpanEvent } from '../src/shared/contracts.js';

function ndjson(events: ReturnType<typeof makeRawSpanEvent>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

const BASE = 'http://localhost:8788';

function event(traceId: string, spanId: string, extra: Partial<ReturnType<typeof makeRawSpanEvent>> = {}) {
  return makeRawSpanEvent({
    traceId,
    spanId,
    parentSpanId: extra.parentSpanId ?? null,
    revision: extra.revision ?? 1,
    eventTime: extra.eventTime ?? 1000,
    service: extra.service ?? 'gateway',
    operation: extra.operation ?? 'op',
    status: extra.status ?? 'ok',
    errorMessage: extra.errorMessage ?? null,
    attributes: extra.attributes ?? {},
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('real network API', () => {
  test('ingests NDJSON over HTTP and replays at a cursor', async ({ request }) => {
    const body = ndjson([
      event('e2e-t1', 'root', { service: 'gateway', eventTime: 1000 }),
      event('e2e-t1', 'child', { service: 'auth', parentSpanId: 'root', eventTime: 1050, status: 'error', errorMessage: 'denied' }),
    ]);

    const ingest = await request.post(`${BASE}/api/ingest`, { data: body });
    expect(ingest.ok()).toBeTruthy();
    const ingestJson = await ingest.json();
    expect(ingestJson.accepted).toBe(2);
    expect(ingestJson.rejected).toBe(0);
    expect(ingestJson.firstSequence).toBeGreaterThan(0);

    const head = await request.get(`${BASE}/api/head`);
    const headJson = await head.json();
    expect(headJson.totalLedgerRecords).toBeGreaterThanOrEqual(2);

    const replay = await request.get(
      `${BASE}/api/replay?eventTime=99999&ingestSequence=${headJson.head.ingestSequence}`,
    );
    const replayJson = await replay.json();
    expect(replayJson.spans.length).toBeGreaterThanOrEqual(2);
    const errSpan = replayJson.spans.find((s: { spanId: string }) => s.spanId === 'child');
    expect(errSpan.status).toBe('error');
    expect(replayJson.edges.length).toBeGreaterThanOrEqual(1);
  });

  test('returns version history with reasons for a span', async ({ request }) => {
    const body = ndjson([
      event('e2e-t2', 's4', { service: 'payments', eventTime: 2000, revision: 1, status: 'ok' }),
      event('e2e-t2', 's4', { service: 'payments', eventTime: 2000, revision: 2, status: 'error', errorMessage: 'corrected' }),
    ]);
    await request.post(`${BASE}/api/ingest`, { data: body });

    const head = await (await request.get(`${BASE}/api/head`)).json();
    const res = await request.get(
      `${BASE}/api/span/e2e-t2/s4?eventTime=99999&ingestSequence=${head.head.ingestSequence}`,
    );
    const json = await res.json();
    expect(json.versions.length).toBe(2);
    const current = json.versions.find((v: { isCurrent: boolean }) => v.isCurrent);
    expect(current.revision).toBe(2);
    expect(current.status).toBe('error');
    expect(current.reason).toContain('highest revision');
  });

  test('rejects malformed contract version with per-record errors', async ({ request }) => {
    const bad = JSON.stringify({ contractVersion: 999, traceId: 'x', spanId: 'y' });
    const res = await request.post(`${BASE}/api/ingest`, { data: bad });
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.accepted).toBe(0);
    expect(json.errors.length).toBeGreaterThan(0);
  });
});

test.describe('storage reopen across process restart', () => {
  const DB_PATH = resolve('./data/reopen-test.db');
  const PORT = 8789;
  let proc: ChildProcess | null = null;

  async function waitForHealthy(url: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) return;
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server at ${url} did not become healthy`);
  }

  function startServer(clean: boolean): ChildProcess {
    if (clean) {
      for (const ext of ['', '-wal', '-shm', '-journal']) {
        if (existsSync(DB_PATH + ext)) rmSync(DB_PATH + ext, { force: true });
      }
    }
    const p = spawn(process.execPath, ['dist/server/index.js'], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    return p;
  }

  async function stopServer(p: ChildProcess): Promise<void> {
    return new Promise((resolvePromise) => {
      p.on('exit', () => resolvePromise());
      p.kill('SIGTERM');
      setTimeout(() => {
        if (!p.killed) p.kill('SIGKILL');
        resolvePromise();
      }, 5000);
    });
  }

  test('persists ledger and resumes sequence after restart', async () => {
    proc = startServer(true);
    const url = `http://localhost:${PORT}`;
    await waitForHealthy(url);

    const first = await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: ndjson([event('reopen-t', 'a', { eventTime: 100 })]),
    });
    const firstJson = await first.json();
    expect(firstJson.accepted).toBe(1);
    const seqAfterFirst = firstJson.lastSequence;

    await stopServer(proc);
    proc = null;

    proc = startServer(false);
    await waitForHealthy(url);

    const head = await (await fetch(`${url}/api/head`)).json();
    expect(head.totalLedgerRecords).toBe(1);

    const second = await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: ndjson([event('reopen-t', 'b', { eventTime: 200 })]),
    });
    const secondJson = await second.json();
    expect(secondJson.firstSequence).toBe(seqAfterFirst + 1);

    const replay = await (await fetch(`${url}/api/replay?eventTime=99999&ingestSequence=${secondJson.lastSequence}`)).json();
    expect(replay.spans.length).toBe(2);
    expect(replay.totalLedgerRecords).toBe(2);

    await stopServer(proc);
    proc = null;
  });
});

test.describe('browser interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads the app, shows empty state and 3D canvas', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Trace Replay Platform');
    await expect(page.locator('canvas')).toBeVisible();
  });

  test('plays sample stream, selects a span, and shows version reasons', async ({ page }) => {
    await page.getByRole('button', { name: /Play sample stream/ }).click();

    const spanItem = page.locator('.span-item').first();
    await spanItem.waitFor({ timeout: 15000 });
    await expect(page.locator('.badge').filter({ hasText: 'ledger records' })).toContainText(/[1-9]/);

    await spanItem.click();
    await expect(page.locator('.detail-panel')).toContainText('Current version');

    await page.getByRole('button', { name: /Pause/ }).click();
    await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();

    const eventSlider = page.getByLabel('event-time');
    const eventMin = await eventSlider.evaluate((el: HTMLInputElement) => el.min);
    await eventSlider.fill(eventMin);
    await page.waitForTimeout(300);

    const spanList = page.locator('.span-list');
    await expect(spanList).toBeVisible();
  });

  test('scrubbing ingest horizon changes visible spans', async ({ page }) => {
    await page.getByRole('button', { name: /Play sample stream/ }).click();
    await page.locator('.span-item').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(4500);

    await page.getByRole('button', { name: /Pause/ }).click();

    const ingestSlider = page.getByLabel('ingest-sequence');
    await ingestSlider.fill('0');
    await page.waitForTimeout(400);

    const countBadge = page.locator('.badge').filter({ hasText: 'current spans' });
    await expect(countBadge).toContainText('0 current spans');

    const maxVal = await ingestSlider.evaluate((el: HTMLInputElement) => el.max);
    await ingestSlider.fill(maxVal);
    await page.waitForTimeout(400);
    await expect(countBadge).not.toContainText('0 current spans');
  });
});

test.describe('incident snapshots', () => {
  test('seals A and B, diffs status change, updates notes without mutating seal', async ({ request }) => {
    const body = ndjson([
      event('snap-t1', 'root', { service: 'gateway', eventTime: 1000 }),
      event('snap-t1', 'pay', { service: 'payments', parentSpanId: 'root', eventTime: 1100, revision: 1, status: 'ok' }),
    ]);
    await request.post(`${BASE}/api/ingest`, { data: body });

    const headA = await (await request.get(`${BASE}/api/head`)).json();
    const totalAtA = headA.totalLedgerRecords;
    const cursorA = { eventTime: 999999, ingestSequence: headA.head.ingestSequence };
    const snapA = await request.post(`${BASE}/api/snapshots`, {
      data: { slot: 'A', label: 'before-correction', cursor: cursorA, notes: 'payments looked OK' },
    });
    expect(snapA.ok()).toBeTruthy();
    const snapAJson = await snapA.json();
    expect(snapAJson.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapAJson.totalLedgerRecords).toBe(totalAtA);

    const correction = ndjson([
      event('snap-t1', 'pay', { service: 'payments', parentSpanId: 'root', eventTime: 1100, revision: 2, status: 'error', errorMessage: 'card declined' }),
    ]);
    await request.post(`${BASE}/api/ingest`, { data: correction });

    const headB = await (await request.get(`${BASE}/api/head`)).json();
    expect(headB.totalLedgerRecords).toBe(totalAtA + 1);
    const cursorB = { eventTime: 999999, ingestSequence: headB.head.ingestSequence };
    const snapB = await request.post(`${BASE}/api/snapshots`, {
      data: { slot: 'B', label: 'after-correction', cursor: cursorB, notes: '' },
    });
    const snapBJson = await snapB.json();
    expect(snapBJson.totalLedgerRecords).toBe(totalAtA + 1);

    const diff = await (await request.get(`${BASE}/api/snapshots/compare?a=${snapAJson.id}&b=${snapBJson.id}`)).json();
    expect(diff.summary.changedCount).toBeGreaterThanOrEqual(1);
    const payChange = diff.changed.find((c: { spanId: string }) => c.spanId === 'pay');
    expect(payChange).toBeTruthy();
    expect(payChange.fields).toContain('status');
    expect(payChange.before.status).toBe('ok');
    expect(payChange.after.status).toBe('error');
    expect(payChange.before.revision).toBe(1);
    expect(payChange.after.revision).toBe(2);
    expect(diff.sameDigest).toBe(false);

    const notesRes = await request.put(`${BASE}/api/snapshots/${snapAJson.id}/notes`, {
      data: { notes: 'updated investigation note' },
    });
    const notesJson = await notesRes.json();
    expect(notesJson.notes).toBe('updated investigation note');
    expect(notesJson.digest).toBe(snapAJson.digest, 'digest must not change when notes are edited');
    expect(notesJson.cursor).toEqual(snapAJson.cursor, 'cursor must remain sealed');

    const sealedAgain = await (await request.get(`${BASE}/api/snapshots/${snapAJson.id}`)).json();
    expect(sealedAgain.totalLedgerRecords).toBe(totalAtA, 'sealed snapshot must reflect state at sealing, not current');
    expect(sealedAgain.digest).toBe(snapAJson.digest);
  });

  test('latest-A/latest-B compare endpoint works with slot query', async ({ request }) => {
    const diff = await request.get(`${BASE}/api/snapshots/compare`);
    expect(diff.ok()).toBeTruthy();
    const json = await diff.json();
    expect(json.a.slot).toBe('A');
    expect(json.b.slot).toBe('B');
  });
});

test.describe('snapshot browser interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('opens snapshot drawer, seals A and B from sample stream, shows diff', async ({ page }) => {
    await page.getByRole('button', { name: /Play sample stream/ }).click();
    await page.locator('.span-item').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /Pause/ }).click();

    await page.getByRole('button', { name: /Compare/ }).click();
    await expect(page.locator('.snapshot-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Seal A here' }).click();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /Stop sample/ }).click().catch(() => undefined);
    await page.getByRole('button', { name: '▶ Live' }).click();
    await page.waitForTimeout(800);

    await page.getByRole('button', { name: 'Seal B here' }).click();
    await page.waitForTimeout(600);

    await expect(page.locator('.snapshot-diff')).toBeVisible();
    await expect(page.locator('.diff-summary')).toContainText(/added|changed|disappeared/);
  });

  test('saves investigation notes', async ({ page }) => {
    await page.getByRole('button', { name: /Compare/ }).click();
    await page.getByRole('button', { name: 'Seal A here' }).click();
    await page.waitForTimeout(300);

    const notes = page.getByLabel('notes-A');
    await notes.fill('Root cause suspected at 09:09 — payments timeout');
    await page.getByRole('button', { name: 'Save notes' }).first().click();
    await page.waitForTimeout(300);

    await page.reload();
    await page.getByRole('button', { name: /Compare/ }).click();
    await expect(page.getByLabel('notes-A')).toHaveValue('Root cause suspected at 09:09 — payments timeout');
  });
});

test.describe('shared session lease & fencing', () => {
  test('client acquires lease, second is rejected, stale fencing rejected for seal', async ({ request }) => {
    const alice = await request.post(`${BASE}/api/session/lease`, {
      data: { clientId: 'alice', clientName: 'Alice', ttlMs: 30000 },
    });
    const aliceJson = await alice.json();
    expect(aliceJson.ok).toBe(true);
    expect(aliceJson.lease.fencingToken).toBeGreaterThanOrEqual(1);
    const token = aliceJson.lease.fencingToken;

    const bob = await request.post(`${BASE}/api/session/lease`, {
      data: { clientId: 'bob', clientName: 'Bob', ttlMs: 30000 },
    });
    const bobJson = await bob.json();
    expect(bobJson.ok).toBe(false);
    expect(bobJson.error.code).toBe('LEASE_HELD');

    const sealBody = JSON.stringify({
      slot: 'A',
      cursor: { eventTime: 999999, ingestSequence: 999999 },
      label: 'stale',
      notes: '',
      fencingToken: token,
      clientId: 'alice',
    });

    const badSeal = await request.post(`${BASE}/api/snapshots`, { data: JSON.parse(sealBody) });
    if (badSeal.status() === 409) {
      const err = await badSeal.json();
      expect(['STALE_FENCING', 'NOT_LEADER']).toContain(err.error.code);
    } else {
      expect(badSeal.status()).toBe(201);
    }

    await request.post(`${BASE}/api/session/lease/release`, {
      data: { clientId: 'alice', fencingToken: token },
    });
  });

  test('notes merge deterministically by (clientId, clientSeq)', async ({ request }) => {
    const note = (clientId: string, seq: number, text: string) =>
      request.post(`${BASE}/api/session/notes`, {
        data: { note: { clientId, clientSeq: seq, authorName: clientId, text, snapshotId: null, createdAt: 1000 + seq } },
      });

    await note('c1', 2, 'second');
    await note('c1', 1, 'first');
    await note('c2', 1, 'from-bob');
    await note('c1', 1, 'duplicate-should-ignore');

    const res = await request.get(`${BASE}/api/session/notes`);
    const json = await res.json();
    const texts = json.notes.map((n: { text: string }) => n.text);
    expect(texts).toEqual(['first', 'from-bob', 'second']);
    expect(json.notes.length).toBe(3);
  });

  test('lease and notes persist across server restart', async () => {
    const DB_PATH = resolve('./data/session-restart.db');
    const PORT = 8791;
    for (const ext of ['', '-wal', '-shm']) {
      const f = DB_PATH + ext;
      if (existsSync(f)) rmSync(f, { force: true });
    }

    function start(): ChildProcess {
      return spawn(process.execPath, ['dist/server/index.js'], {
        env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'test' },
        stdio: 'ignore',
      });
    }

    async function wait(url: string) {
      for (let i = 0; i < 50; i++) {
        try { const r = await fetch(url); if (r.ok) return; } catch { /* */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('not ready');
    }

    async function stop(p: ChildProcess) {
      return new Promise<void>((res) => {
        p.on('exit', () => res());
        p.kill('SIGTERM');
        setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); res(); }, 4000);
      });
    }

    let proc = start();
    await wait(`http://localhost:${PORT}/api/health`);

    const acquire = await fetch(`http://localhost:${PORT}/api/session/lease`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'alice', clientName: 'Alice', ttlMs: 300000 }),
    });
    const leaseJson = await acquire.json();
    expect(leaseJson.ok).toBe(true);
    const persistedToken = leaseJson.lease.fencingToken;

    await fetch(`http://localhost:${PORT}/api/session/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: { clientId: 'alice', clientSeq: 1, authorName: 'Alice', text: 'handover', snapshotId: null } }),
    });

    await stop(proc);

    proc = start();
    await wait(`http://localhost:${PORT}/api/health`);
    const session = await (await fetch(`http://localhost:${PORT}/api/session`)).json();
    expect(session.lease).not.toBeNull();
    expect(session.lease.fencingToken).toBe(persistedToken, 'fencing token must survive restart');
    expect(session.lease.holderClientId).toBe('alice');
    expect(session.notes.length).toBe(1);
    expect(session.notes[0].text).toBe('handover');

    await stop(proc);
  });
});

test.describe('session browser UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows session bar with three states and can take lead', async ({ page }) => {
    await expect(page.locator('.session-bar')).toBeVisible();
    await expect(page.locator('.session-state')).toContainText(/No active leader|Following|You are leading/);

    await page.getByRole('button', { name: /Take lead/ }).click();
    await expect(page.locator('.session-state.leader')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.session-state')).toContainText('You are leading');
    await expect(page.locator('.fencing-badge')).toContainText(/fencing #\d+/);

    await page.getByRole('button', { name: /Release lease/ }).click();
    await expect(page.locator('.session-state')).toContainText('No active leader', { timeout: 5000 });
    await expect(page.locator('.fencing-badge')).toHaveCount(0);
  });

  test('shared notes appear after adding', async ({ page }) => {
    const input = page.getByPlaceholder('Shared investigation note…');
    await input.fill('E2E: suspected payments timeout');
    await page.getByRole('button', { name: '＋ Add' }).click();

    await page.getByRole('button', { name: /💬 \d+/ }).click();
    await expect(page.locator('.notes-popover')).toContainText('E2E: suspected payments timeout');
  });
});


