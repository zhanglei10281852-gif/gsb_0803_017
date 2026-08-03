import fs from "node:fs";
import { generateSample, planToNdjson } from "./generator.js";

interface CliArgs {
  url: string;
  speed: number;
  file: string | null;
  seed: string;
  batchSize: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    url: "http://127.0.0.1:8317",
    speed: 500,
    file: null,
    seed: "gsb-017",
    batchSize: 100,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = String(argv[++i]);
    else if (a === "--speed") args.speed = Number(argv[++i]);
    else if (a === "--fast") args.speed = 1e9;
    else if (a === "--file") args.file = String(argv[++i]);
    else if (a === "--seed") args.seed = String(argv[++i]);
    else if (a === "--batch-size") args.batchSize = Number(argv[++i]);
  }
  if (!Number.isFinite(args.speed) || args.speed <= 0) throw new Error("--speed 必须为正数");
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: Array<{ line: number; error: string }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = generateSample(args.seed);
  console.log(
    `[sample] 种子=${plan.seed} 发送 ${plan.sends.length} 条（唯一事件 ${plan.stats.uniqueEvents}，重复 ${plan.stats.duplicateSends}，事故 span ${plan.stats.incidentSpans.length} 个）`,
  );

  if (args.file) {
    fs.writeFileSync(args.file, planToNdjson(plan));
    console.log(`[sample] 已写入 ${args.file}`);
    return;
  }

  const base = args.url.replace(/\/$/, "");
  const health = await fetch(`${base}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`[sample] 无法连接服务端 ${base}，请先 npm start`);
    process.exitCode = 1;
    return;
  }

  const first = plan.sends[0];
  const t0 = first ? first.sendAtMs : 0;
  const started = Date.now();
  let sent = 0;
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;

  for (let i = 0; i < plan.sends.length; i += args.batchSize) {
    const batch = plan.sends.slice(i, i + args.batchSize);
    const head = batch[0];
    if (head) {
      const target = (head.sendAtMs - t0) / args.speed;
      const wait = target - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
    const body = batch.map((s) => JSON.stringify(s.event)).join("\n") + "\n";
    const res = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
    });
    if (!res.ok) {
      console.error(`[sample] 批次失败 HTTP ${res.status}: ${await res.text()}`);
      process.exitCode = 1;
      return;
    }
    const json = (await res.json()) as IngestResponse;
    accepted += json.accepted;
    duplicates += json.duplicates;
    rejected += json.rejected.length;
    sent += batch.length;
    console.log(`[sample] 已发送 ${sent}/${plan.sends.length}（接受 ${accepted}，去重 ${duplicates}）`);
  }

  const headRes = await fetch(`${base}/api/head`);
  const headJson = (await headRes.json()) as { totalEntries: number };
  const expected = plan.stats.uniqueEvents;
  const consistent =
    headJson.totalEntries === expected && accepted === expected && rejected === 0;
  console.log(
    `[sample] 完成：接受 ${accepted}，重复 ${duplicates}，服务端账本 ${headJson.totalEntries}，期望 ${expected} → ${consistent ? "一致" : "不一致"}`,
  );
  if (!consistent) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
