import { expect, test } from '@playwright/test';

const TRACE = 'trace-incident-0001';

test('loads real-time view ingested over HTTP and renders topology', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('topology-canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('toggle-live')).toContainText('暂停回放');
  await expect(page.locator('.badge').filter({ hasText: 'ledger' })).toContainText(/ledger\s+\d+/);
  await expect(page.getByTestId('topology-stats')).toContainText(/节点\s*[1-9]/);
});

test('pauses, scrubs timeline, and shows a superseded span version', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('toggle-live').click();
  await expect(page.getByTestId('toggle-live')).toContainText('回到实时');

  const timeline = page.getByTestId('timeline');
  const minAttr = await timeline.getAttribute('min');
  const maxAttr = await timeline.getAttribute('max');
  const min = Number(minAttr ?? '0');
  const max = Number(maxAttr ?? '10');
  const target = Math.min(max, Math.max(min, 5));
  await timeline.evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, target);

  const invItem = page.getByTestId('span-item-inv-1');
  await invItem.waitFor({ state: 'visible', timeout: 10000 });
  await invItem.click();

  const detail = page.getByTestId('span-detail');
  await expect(detail).toContainText('inventory / reserveStock');
  const versions = page.locator('[data-testid^="version-"]');
  expect(await versions.count()).toBeGreaterThanOrEqual(2);
});

test('live updates after a new real NDJSON POST (websocket refresh)', async ({ page }) => {
  await page.goto('/');
  const before = await page.locator('.badge').filter({ hasText: 'ledger' }).innerText();
  const beforeCount = Number(before.replace(/\D/g, ''));

  const event = {
    contractVersion: 1,
    traceId: TRACE,
    spanId: 'live-late-1',
    parentSpanId: 'gw-1',
    service: 'realtime',
    operation: 'liveArrival',
    kind: 'consumer' as const,
    status: 'ok' as const,
    startTime: 1_700_000_001_000,
    endTime: 1_700_000_001_500,
    revision: 1,
    eventTime: 1_700_000_999_000,
    attributes: { source: 'e2e-live' }
  };
  const res = await page.request.post('/api/ingest', {
    headers: { 'Content-Type': 'application/x-ndjson' },
    data: JSON.stringify(event)
  });
  expect(res.ok()).toBeTruthy();

  await expect(page.locator('.badge').filter({ hasText: 'ledger' })).toContainText(
    `ledger ${beforeCount + 1}`,
    { timeout: 10000 }
  );
});

test('service filter syncs list and topology, and detail is reachable', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('service-tab-payment').click();
  const items = page.getByTestId('span-item-pay-1');
  await expect(items.first()).toBeVisible();
  await items.first().click();
  await expect(page.getByTestId('span-detail')).toContainText('payment / charge');
});
