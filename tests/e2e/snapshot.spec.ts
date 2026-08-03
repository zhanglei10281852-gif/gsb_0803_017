import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './server';
import { seedIncident, ingest } from './seed';
import { buildScript } from '../../src/sample/script';

test.describe('incident snapshots & comparison (real server + browser)', () => {
  let server: RunningServer;

  test.afterEach(async () => {
    if (server) await server.stop();
  });

  test('seals A/B from the UI with a note and shows the A->B diff', async ({ page }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    await page.goto(server.baseUrl);
    await expect(page.getByTestId('snapshot-panel')).toBeVisible();

    // Snapshot A: scrub the ingest slider back to #1 (early knowledge), then seal.
    const ingestSlider = page.getByTestId('scrub-ingest');
    await ingestSlider.focus();
    await ingestSlider.fill('1');
    await ingestSlider.dispatchEvent('input');
    await expect(page.getByTestId('mode-badge')).toHaveText('REPLAY');
    await page.getByTestId('snapshot-note').fill('A: only earliest span known');
    await page.getByTestId('seal-snapshot').click();
    await expect(page.getByTestId('snapshot-1')).toBeVisible();

    // Snapshot B: switch back to live head, then seal the full picture.
    await page.getByTestId('mode-toggle').click(); // paused -> live
    await expect(page.getByTestId('mode-badge')).toHaveText('LIVE');
    await page.getByTestId('snapshot-note').fill('B: full incident known');
    await page.getByTestId('seal-snapshot').click();
    await expect(page.getByTestId('snapshot-2')).toBeVisible();

    // Pick A=#1, B=#2 and compare.
    await page.getByTestId('pick-from-1').click();
    await page.getByTestId('pick-to-2').click();
    await page.getByTestId('compare-button').click();

    const result = page.getByTestId('comparison-result');
    await expect(result).toBeVisible();
    // Going from "one record known" to "all known" must add spans.
    await expect(page.getByTestId('diff-summary')).toContainText('新增');
    await expect(page.getByTestId('delta-added')).toBeVisible();
  });

  test('a sealed snapshot keeps its digest after a late event arrives', async ({ page }) => {
    server = await startServer();
    await seedIncident(server.baseUrl);
    await page.goto(server.baseUrl);

    // Seal the current (live) cursor via the UI.
    await page.getByTestId('seal-snapshot').click();
    await expect(page.getByTestId('snapshot-1')).toBeVisible();

    const before = await (await page.request.get(`${server.baseUrl}/api/snapshots/1`)).json();
    const digestBefore = before.snapshot.provenance.digest as string;

    // A late event arrives over the real network AFTER sealing.
    await ingest(server.baseUrl, [
      {
        contractVersion: 1,
        traceId: 'trace-late-e2e',
        spanId: 'late-e2e',
        parentSpanId: null,
        service: 'late',
        operation: 'op',
        revision: 0,
        eventTimeMs: 1_700_000_000_500,
        durationMs: 1,
        status: 'error',
        revisionReason: null,
        errorKind: 'Late',
      },
    ]);

    // The sealed snapshot still verifies to the same digest and excludes the late span.
    const verify = await (await page.request.get(`${server.baseUrl}/api/snapshots/1/verify`)).json();
    expect(verify.valid).toBe(true);
    expect(verify.digest).toBe(digestBefore);
    const after = await (await page.request.get(`${server.baseUrl}/api/snapshots/1`)).json();
    expect(after.snapshot.provenance.digest).toBe(digestBefore);
    expect(after.view.spans.find((s: { spanId: string }) => s.spanId === 'late-e2e')).toBeUndefined();
  });

  test('sealed snapshot digest is stable across a server restart (SQLite recovery)', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-snap-'));
    const dbPath = join(dir, 'ledger.sqlite');
    try {
      server = await startServer({ dbPath });
      await seedIncident(server.baseUrl);
      await page.goto(server.baseUrl);
      await page.getByTestId('snapshot-note').fill('survives restart');
      await page.getByTestId('seal-snapshot').click();
      await expect(page.getByTestId('snapshot-1')).toBeVisible();

      const before = await (await page.request.get(`${server.baseUrl}/api/snapshots/1`)).json();
      const digestBefore = before.snapshot.provenance.digest as string;

      // Restart against the SAME database (no re-ingest).
      await server.stop();
      server = await startServer({ dbPath });

      const after = await (await page.request.get(`${server.baseUrl}/api/snapshots/1`)).json();
      expect(after.snapshot.provenance.digest).toBe(digestBefore);
      expect(after.snapshot.note).toBe('survives restart');

      const verify = await (await page.request.get(`${server.baseUrl}/api/snapshots/1/verify`)).json();
      expect(verify.valid).toBe(true);

      // The page renders the recovered snapshot after restart.
      await page.goto(server.baseUrl);
      await expect(page.getByTestId('snapshot-1')).toBeVisible();
    } finally {
      if (server) await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
