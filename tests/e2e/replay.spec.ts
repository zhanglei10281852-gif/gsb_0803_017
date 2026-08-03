import { expect, test } from "@playwright/test";

const TRACE = "trace-incident-0001";

test("loads real-time view ingested over HTTP and renders topology", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("topology-canvas")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId("toggle-live")).toContainText("暂停回放");
  await expect(
    page.locator(".badge").filter({ hasText: "ledger" }),
  ).toContainText(/ledger\s+\d+/);
  await expect(page.getByTestId("topology-stats")).toContainText(
    /节点\s*[1-9]/,
  );
});

test("pauses, scrubs timeline, and shows a superseded span version", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("toggle-live").click();
  await expect(page.getByTestId("toggle-live")).toContainText("回到实时");

  const timeline = page.getByTestId("timeline");
  const minAttr = await timeline.getAttribute("min");
  const maxAttr = await timeline.getAttribute("max");
  const min = Number(minAttr ?? "0");
  const max = Number(maxAttr ?? "10");
  const target = Math.min(max, Math.max(min, 5));
  await timeline.evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, target);

  const invItem = page.getByTestId("span-item-inv-1");
  await invItem.waitFor({ state: "visible", timeout: 10000 });
  await invItem.click();

  const detail = page.getByTestId("span-detail");
  await expect(detail).toContainText("inventory / reserveStock");
  const versions = page.locator('[data-testid^="version-"]');
  expect(await versions.count()).toBeGreaterThanOrEqual(2);
});

test("live updates after a new real NDJSON POST (websocket refresh)", async ({
  page,
}) => {
  await page.goto("/");
  const before = await page
    .locator(".badge")
    .filter({ hasText: "ledger" })
    .innerText();
  const beforeCount = Number(before.replace(/\D/g, ""));

  const event = {
    contractVersion: 1,
    traceId: TRACE,
    spanId: "live-late-1",
    parentSpanId: "gw-1",
    service: "realtime",
    operation: "liveArrival",
    kind: "consumer" as const,
    status: "ok" as const,
    startTime: 1_700_000_001_000,
    endTime: 1_700_000_001_500,
    revision: 1,
    eventTime: 1_700_000_999_000,
    attributes: { source: "e2e-live" },
  };
  const res = await page.request.post("/api/ingest", {
    headers: { "Content-Type": "application/x-ndjson" },
    data: JSON.stringify(event),
  });
  expect(res.ok()).toBeTruthy();

  await expect(
    page.locator(".badge").filter({ hasText: "ledger" }),
  ).toContainText(`ledger ${beforeCount + 1}`, { timeout: 10000 });
});

test("service filter syncs list and topology, and detail is reachable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("service-tab-payment").click();
  const items = page.getByTestId("span-item-pay-1");
  await expect(items.first()).toBeVisible();
  await items.first().click();
  await expect(page.getByTestId("span-detail")).toContainText(
    "payment / charge",
  );
});

test("seals A/B snapshots, shows diff, persists notes and sealed digests on reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("toggle-live").click();

  const timeline = page.getByTestId("timeline");
  const maxAttr = await timeline.getAttribute("max");
  const max = Number(maxAttr ?? "10");

  await page.getByTestId("tab-snapshots").click();

  await timeline.evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, 5);
  await page.getByTestId("capture-a").click();

  await timeline.evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, max);
  await page.getByTestId("capture-b").click();

  const detail = page.getByTestId("snapshot-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("digest-a")).not.toHaveText(/^0{10}$/);
  await expect(page.getByTestId("digest-b")).not.toHaveText(/^0{10}$/);

  const digestAText = await page.getByTestId("digest-a").innerText();
  const digestBText = await page.getByTestId("digest-b").innerText();

  await page
    .getByTestId("snapshot-notes")
    .fill("确认是 inventory 修订导致错误传播");
  await page.getByTestId("save-notes").click();
  await expect(page.locator(".snap-message")).toContainText("备注已保存");

  const savedList = await page.request.get("/api/snapshots");
  const savedJson = (await savedList.json()) as {
    snapshots: { id: string; notes: string }[];
  };
  const saved = savedJson.snapshots.find((s) => s.notes.length > 0);
  expect(saved?.notes).toBe("确认是 inventory 修订导致错误传播");
  const savedId = saved!.id.slice(0, 8);

  await page.reload();
  await page.getByTestId("tab-snapshots").click();
  const historyItem = page.getByTestId(`snap-history-${savedId}`);
  await historyItem.waitFor({ state: "visible", timeout: 10000 });
  await historyItem.click();

  await expect(page.getByTestId("snapshot-detail")).toBeVisible();
  await expect(page.getByTestId("digest-a")).toHaveText(digestAText);
  await expect
    .poll(async () => page.getByTestId("snapshot-notes").inputValue(), {
      timeout: 10000,
    })
    .toBe("确认是 inventory 修订导致错误传播");
});
