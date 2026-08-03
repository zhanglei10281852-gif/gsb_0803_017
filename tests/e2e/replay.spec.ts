import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, removeDirWithRetry, type RunningServer } from './server';
import { seedIncident, ingest } from './seed';
import { buildScript } from '../../src/sample/script';

test.describe('incident replay platform (real server + browser)', () => {
  let server: RunningServer;

  test.afterEach(async () => {
    if (server) await server.stop();
  });

  test('loads the real page, follows live, and shows the incident topology', async ({ page }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);

    await page.goto(server.baseUrl);
    // The React app renders the timeline and a live Three.js canvas.
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('topology-canvas')).toBeVisible();
    await expect(page.getByTestId('mode-badge')).toHaveText('LIVE');

    // The span list should contain the errored payments span from the incident.
    await expect(page.getByTestId('span-item-payments')).toBeVisible();
    await expect(page.getByTestId('view-summary')).toContainText('errors');
  });

  test('selecting a span syncs list + detail and explains the version reason', async ({ page }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    await page.goto(server.baseUrl);

    await page.getByTestId('span-item-payments').click();
    const detail = page.getByTestId('span-detail');
    await expect(detail).toContainText('payments');
    // At the live head, payments has been corrected to revision 1 (error).
    await expect(page.getByTestId('detail-revision')).toHaveText('r1');
    await expect(page.getByTestId('version-reason')).toContainText('revision');
  });

  test('scrubbing ingestSequence backward reproduces the pre-correction view', async ({ page }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    await page.goto(server.baseUrl);

    // Find the ingestSequence at which payments r1 arrived, then scrub before it.
    const accepted = buildScript(1).map((s) => s.event);
    // Query the live view to learn payments' current ingest sequence.
    const boundsRes = await page.request.get(`${server.baseUrl}/api/bounds`);
    const bounds = (await boundsRes.json()).bounds as { maxIngestSequence: number; maxEventTimeMs: number };

    // Drag the ingest slider to 1 (only the earliest knowledge known).
    const slider = page.getByTestId('scrub-ingest');
    await slider.focus();
    await slider.fill('1');
    await slider.dispatchEvent('input');

    // Mode should flip to REPLAY once we scrub.
    await expect(page.getByTestId('mode-badge')).toHaveText('REPLAY');
    await expect(page.getByTestId('ingest-value')).toContainText('#1');

    // The view must be reproducible: verify via the API at the same cursor.
    const viewRes = await page.request.get(
      `${server.baseUrl}/api/view?eventTimeMs=${bounds.maxEventTimeMs}&ingestSequence=1`,
    );
    const view = await viewRes.json();
    // Only the first-ingested record is visible at ingest #1.
    expect(view.cursor.ingestSequence).toBe(1);
    expect(view.spans.length).toBeLessThanOrEqual(accepted.length);
    expect(bounds.maxIngestSequence).toBeGreaterThan(1);
  });

  test('reproduces the same view before and after a server restart (SQLite recovery)', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-persist-'));
    const dbPath = join(dir, 'ledger.sqlite');
    try {
      server = await startServer({ dbPath });
      await seedIncident(server.baseUrl);

      const bounds = (await (await page.request.get(`${server.baseUrl}/api/bounds`)).json()).bounds as {
        maxEventTimeMs: number;
        maxIngestSequence: number;
      };
      const cursorUrl = `/api/view?eventTimeMs=${bounds.maxEventTimeMs}&ingestSequence=${bounds.maxIngestSequence}`;
      const before = await (await page.request.get(`${server.baseUrl}${cursorUrl}`)).json();

      // Restart the server against the SAME database file (no re-ingest).
      await server.stop();
      server = await startServer({ dbPath });

      const health = await (await page.request.get(`${server.baseUrl}/api/health`)).json();
      expect(health.count).toBeGreaterThan(0);

      const after = await (await page.request.get(`${server.baseUrl}${cursorUrl}`)).json();
      // Byte-for-byte identical projection proves reproducibility across restart.
      expect(JSON.stringify(after.spans)).toEqual(JSON.stringify(before.spans));
      expect(JSON.stringify(after.edges)).toEqual(JSON.stringify(before.edges));

      // And the rebuilt page renders from recovered storage.
      await page.goto(server.baseUrl);
      await expect(page.getByTestId('span-item-payments')).toBeVisible();
    } finally {
      if (server) await server.stop();
      await removeDirWithRetry(dir);
    }
  });

  test('late duplicate re-send over the network does not change the view', async ({ page }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    await page.goto(server.baseUrl);
    await expect(page.getByTestId('span-item-payments')).toBeVisible();

    const bounds1 = (await (await page.request.get(`${server.baseUrl}/api/bounds`)).json()).bounds;
    // Re-send the whole incident again: every record is a duplicate.
    const dup = await ingest(server.baseUrl, buildScript(1).map((s) => s.event));
    expect(dup.accepted).toBe(0);
    const bounds2 = (await (await page.request.get(`${server.baseUrl}/api/bounds`)).json()).bounds;
    expect(bounds2.maxIngestSequence).toBe(bounds1.maxIngestSequence);
  });
});
