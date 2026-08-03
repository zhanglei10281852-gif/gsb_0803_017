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
