import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

interface IncidentSpan {
  traceId: string;
  spanId: string;
  service: string;
  finalRevision: number;
  finalStatus: string;
}

interface Expectations {
  stats: {
    uniqueEvents: number;
    duplicateSends: number;
    incidentSpans: IncidentSpan[];
  };
  head: {
    cursor: { eventTime: number; ingestSequence: number };
    totalEntries: number;
  };
  baseTimeMs: number;
  durationMs: number;
}

interface ReplayHook {
  contractVersion: number;
  store: {
    getSnapshot(): {
      mode: string;
      cursor: { eventTime: number; ingestSequence: number };
      selection: { traceId: string; spanId: string } | null;
    };
  };
  screenPosForService(service: string): { x: number; y: number } | null;
  highlightSummary(): { selectedService: string | null; highlightedEdges: string[]; errorEdges: string[] } | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const expectations = JSON.parse(
  fs.readFileSync(path.join(here, ".tmp", "expectations.json"), "utf8"),
) as Expectations;
const BASE = "http://127.0.0.1:8377";

async function waitAppReady(page: Page, expectedTotal = expectations.head.totalEntries): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status-chip")).toHaveText("实时连接", { timeout: 30_000 });
  await expect(page.getByTestId("totals")).toContainText(`账本 ${expectedTotal} 条`);
}

async function incidentSeqs(): Promise<{ r1: number; r2: number; span: IncidentSpan }> {
  const span = expectations.stats.incidentSpans[0];
  if (!span) throw new Error("样例中没有事故 span");
  const res = await fetch(`${BASE}/api/ledger?since=0`);
  const json = (await res.json()) as {
    entries: Array<{ ingestSequence: number; event: { traceId: string; spanId: string; revision: number } }>;
  };
  const versions = json.entries.filter(
    (e) => e.event.traceId === span.traceId && e.event.spanId === span.spanId,
  );
  const r1 = versions.find((v) => v.event.revision === 1)?.ingestSequence;
  const r2 = versions.find((v) => v.event.revision === 2)?.ingestSequence;
  if (r1 === undefined || r2 === undefined) throw new Error("事故 span 版本不全");
  return { r1, r2, span };
}

test("实时跟随：三维拓扑、列表与统计随真实灌流渲染", async ({ page }) => {
  await waitAppReady(page);
  await expect(page.getByTestId("mode-chip")).toHaveText("实时跟随");
  await expect(page.getByTestId("topology-canvas")).toBeVisible();
  const rows = page.locator('[data-testid^="span-row-"]');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(50);
  // 服务标签出现在三维场景中（DOM 侧无节点文本，通过钩子断言布局）
  const pos = await page.evaluate(() => (window as unknown as { __replay?: ReplayHook }).__replay?.screenPosForService("payments"));
  expect(pos).not.toBeNull();
});

test("双坐标游标回放可重复：版本生效理由随 ingest 坐标确定切换", async ({ page }) => {
  await waitAppReady(page);
  const { r2, span } = await incidentSeqs();

  await page.getByTestId("mode-toggle").click();
  await expect(page.getByTestId("mode-chip")).toHaveText("暂停回放");

  // ingest 坐标回拨到迟到修订 r2 之前 → r1 生效、r2 游标外
  await page.getByTestId("ingest-slider").fill(String(r2 - 1));
  await expect(page.getByTestId("cursor-readout")).toContainText(`ingest=${r2 - 1}`);

  await page.getByTestId("filter-input").fill(span.spanId);
  await page.getByTestId(`span-row-${span.spanId}`).click();

  await expect(page.getByTestId("role-r1")).toHaveText("当前生效");
  const reasonBefore = (await page.getByTestId("reason-r1").textContent()) ?? "";
  expect(reasonBefore).toContain("最高修订");
  await expect(page.getByTestId("role-r2")).toHaveText("游标外");
  await expect(page.getByTestId("reason-r2")).toContainText("游标");

  // ingest 坐标推进到 r2 → r2 生效且为错误
  await page.getByTestId("ingest-slider").fill(String(r2));
  await expect(page.getByTestId("role-r2")).toHaveText("当前生效");
  await expect(page.getByTestId("error-banner")).toBeVisible();

  // 再次回拨：理由与第一次完全一致（可复盘、可重复生成）
  await page.getByTestId("ingest-slider").fill(String(r2 - 1));
  await expect(page.getByTestId("role-r1")).toHaveText("当前生效");
  const reasonAgain = (await page.getByTestId("reason-r1").textContent()) ?? "";
  expect(reasonAgain).toBe(reasonBefore);
});

test("三维场景、列表、详情的选择双向同步", async ({ page }) => {
  await waitAppReady(page);
  await page.getByTestId("mode-toggle").click();

  // 3D → 列表/详情：点击 payments 节点
  const pos = await page.evaluate(
    () => (window as unknown as { __replay?: ReplayHook }).__replay?.screenPosForService("payments"),
  );
  if (!pos) throw new Error("payments 节点不在场景中");
  await page.mouse.click(pos.x, pos.y);

  await expect(page.getByTestId("service-filter")).toContainText("payments");
  const selection = await page.evaluate(
    () => (window as unknown as { __replay?: ReplayHook }).__replay?.store.getSnapshot().selection,
  );
  expect(selection?.spanId).toBeTruthy();
  await expect(page.getByTestId(`span-row-${selection?.spanId}`)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("details")).toContainText("payments");
  await expect(page.getByTestId("causal-path")).toBeVisible();

  // 列表 → 3D/详情：改选另一个 span
  const row = page.locator('[data-testid^="span-row-"]').nth(3);
  const testid = await row.getAttribute("data-testid");
  await row.click();
  const selection2 = await page.evaluate(
    () => (window as unknown as { __replay?: ReplayHook }).__replay?.store.getSnapshot().selection,
  );
  expect(`span-row-${selection2?.spanId}`).toBe(testid);
  const summary = await page.evaluate(
    () => (window as unknown as { __replay?: ReplayHook }).__replay?.highlightSummary(),
  );
  expect(summary).not.toBeNull();
  await expect(page.getByTestId("details")).toContainText(String(selection2?.spanId));
});

test("暂停期间迟到事件可见提示，可一键吸收到游标", async ({ page }) => {
  await waitAppReady(page);
  await page.getByTestId("mode-toggle").click();
  const headSeq = expectations.head.cursor.ingestSequence;

  // 真实网络再写入：一条写入过去时点 + 一条写入未来
  const probe = [
    {
      contract: "span-event/1",
      producerId: "e2e-probe",
      eventId: "p-past",
      traceId: "tr-probe",
      spanId: "sp-probe-past",
      parentSpanId: null,
      service: "probe",
      operation: "late-past",
      eventTime: expectations.baseTimeMs + 60_000,
      durationMs: 5,
      revision: 1,
      status: "ok",
      errorMessage: null,
      attributes: {},
    },
    {
      contract: "span-event/1",
      producerId: "e2e-probe",
      eventId: "p-future",
      traceId: "tr-probe",
      spanId: "sp-probe-future",
      parentSpanId: null,
      service: "probe",
      operation: "late-future",
      eventTime: expectations.baseTimeMs + 600_000,
      durationMs: 5,
      revision: 1,
      status: "ok",
      errorMessage: null,
      attributes: {},
    },
  ];
  const res = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: probe.map((e) => JSON.stringify(e)).join("\n") + "\n",
  });
  expect(res.ok).toBe(true);

  await expect(page.getByTestId("late-banner")).toContainText("新到达 2 条，其中 1 条写入过去时点");
  await page.getByTestId("absorb-btn").click();
  await expect(page.getByTestId("late-banner")).toHaveCount(0);
  await expect(page.getByTestId("ingest-readout")).toHaveText(`${headSeq + 2} / ${headSeq + 2}`);
});

test("事故快照：封存 A/B 游标、差异与备注、迟到不改写已封存结果", async ({ page }) => {
  // 前一个用例已注入 2 条探针事件
  await waitAppReady(page, expectations.head.totalEntries + 2);
  const { r2 } = await incidentSeqs();

  await page.getByTestId("mode-toggle").click();
  await page.getByTestId("snapshot-toggle").click();

  // A：迟到修订 r2 生效之前；B：r2 生效之后
  await page.getByTestId("ingest-slider").fill(String(r2 - 1));
  await page.getByTestId("seal-a-btn").click();
  await expect(page.getByTestId("seal-readout")).toContainText(`ingest=${r2 - 1}`);
  await page.getByTestId("ingest-slider").fill(String(r2));
  await page.getByTestId("seal-b-btn").click();

  await page.getByTestId("seal-create-btn").click();
  await expect(page.getByTestId("seal-msg")).toContainText("已封存 snap-");
  const items = page.locator('[data-testid^="snapshot-item-"]');
  await expect(items).toHaveCount(1);

  // 差异摘要：恰好 1 个 span 变化（状态翻转）+ 1 条边变化 + 1 条错误路径变化
  await expect(page.getByTestId("diff-summary")).toContainText("变化 1");
  await expect(page.getByTestId("diff-summary")).toContainText("状态翻转 1");
  await expect(page.getByTestId("diff-summary")).toContainText("错误路径 1");

  // 详情：digest、高水位、复核一致
  const testid = (await items.first().getAttribute("data-testid")) ?? "";
  const snapshotId = testid.replace("snapshot-item-", "");
  expect(snapshotId).toMatch(/^snap-[0-9a-f]{16}$/);
  await expect(page.getByTestId("snapshot-digest")).toBeVisible();
  await expect(page.getByTestId("snapshot-highwater")).toContainText("entries=");
  await page.getByTestId("verify-btn").click();
  await expect(page.getByTestId("verify-result")).toContainText("一致");

  // span 变化行可联动主界面选择（同一套选择同步，而非旁路）
  const spanChange = page.locator('[data-testid^="span-change-"]');
  await expect(spanChange).toHaveCount(1);
  await spanChange.first().click();
  const selection = await page.evaluate(
    () => (window as unknown as { __replay?: ReplayHook }).__replay?.store.getSnapshot().selection,
  );
  expect(selection?.spanId).toBeTruthy();
  await expect(page.getByTestId("details")).toContainText(String(selection?.spanId));

  // 调查备注：追加并展示
  await page.getByTestId("note-author").fill("值班-张");
  await page.getByTestId("note-input").fill("payments r2 为迟到修订，确认告警延迟根因");
  await page.getByTestId("note-submit").click();
  await expect(page.locator('[data-testid^="note-item-"]')).toHaveCount(1);

  // 相同游标重复封存：幂等，不产生新快照
  await page.getByTestId("seal-create-btn").click();
  await expect(page.getByTestId("seal-msg")).toContainText("已存在相同快照");
  await expect(page.locator('[data-testid^="snapshot-item-"]')).toHaveCount(1);

  // 迟到事件写入过去时点：已封存摘要不变（API 复核），新游标才能产生新快照
  const lateProbe = {
    contract: "span-event/1",
    producerId: "e2e-probe",
    eventId: "p-late-2",
    traceId: "tr-probe",
    spanId: "sp-probe-late2",
    parentSpanId: null,
    service: "probe",
    operation: "late-again",
    eventTime: expectations.baseTimeMs + 120_000,
    durationMs: 5,
    revision: 1,
    status: "ok",
    errorMessage: null,
    attributes: {},
  };
  const res = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: JSON.stringify(lateProbe) + "\n",
  });
  expect(res.ok).toBe(true);
  const verify = (await (
    await fetch(`${BASE}/api/snapshots/${snapshotId}/verify`)
  ).json()) as { match: boolean; digest: string; checkedEntries: number };
  expect(verify.match).toBe(true);
  expect(verify.checkedEntries).toBe(expectations.head.totalEntries + 3);

  // 推进 B 的 ingest 坐标到头 → 新快照（先等客户端经 WS 收到探针、head 刷新）
  const headSeq = expectations.head.cursor.ingestSequence + 3;
  await expect(page.getByTestId("ingest-readout")).toContainText(`/ ${headSeq}`);
  await page.getByTestId("ingest-slider").fill(String(headSeq));
  await page.getByTestId("seal-b-btn").click();
  await page.getByTestId("seal-create-btn").click();
  await expect(page.locator('[data-testid^="snapshot-item-"]')).toHaveCount(2);
});

test("窄屏布局：tabs 切换完成选择、回放与游标操作", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  // 前面用例已注入 3 条探针事件
  await waitAppReady(page, expectations.head.totalEntries + 3);

  await page.getByTestId("mode-toggle").click();
  await expect(page.getByTestId("mode-chip")).toHaveText("暂停回放");

  await page.getByTestId("tab-list").click();
  const span = expectations.stats.incidentSpans[0];
  if (!span) throw new Error("缺少事故 span");
  await page.getByTestId("filter-input").fill(span.spanId);
  await page.getByTestId(`span-row-${span.spanId}`).click();

  // 选择后自动跳到详情 tab，生效理由可见
  await expect(page.getByTestId("details")).toContainText(span.spanId);
  await expect(page.getByTestId("reason-r2").first()).toBeVisible();

  // 窄屏下时间线仍可拖动
  const track = page.getByTestId("timeline-track");
  const box = await track.boundingBox();
  if (!box) throw new Error("时间线不可见");
  const before = (await page.getByTestId("cursor-readout").textContent()) ?? "";
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await page.getByTestId("cursor-readout").textContent()) ?? "";
  expect(after).not.toBe(before);
});
