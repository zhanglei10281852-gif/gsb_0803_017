import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSample } from "../sample/src/generator.js";

const BASE = "http://127.0.0.1:8377";

interface HeadResponse {
  cursor: { eventTime: number; ingestSequence: number };
  totalEntries: number;
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // webServer 尚未就绪，继续等
    }
    if (Date.now() > deadline) throw new Error("e2e 服务端启动超时");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 通过真实 HTTP NDJSON 把确定性样例流灌入运行中的服务端，并落盘期望值。 */
export default async function globalSetup(): Promise<void> {
  await waitHealthy();
  const plan = generateSample("gsb-017");
  const lines = plan.sends.map((s) => JSON.stringify(s.event));

  let accepted = 0;
  let duplicates = 0;
  for (let i = 0; i < lines.length; i += 200) {
    const body = lines.slice(i, i + 200).join("\n") + "\n";
    const res = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
    });
    if (!res.ok) throw new Error(`灌流失败 HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { accepted: number; duplicates: number };
    accepted += json.accepted;
    duplicates += json.duplicates;
  }
  if (accepted !== plan.stats.uniqueEvents || duplicates !== plan.stats.duplicateSends) {
    throw new Error(
      `灌流不一致：accepted=${accepted}/${plan.stats.uniqueEvents} duplicates=${duplicates}/${plan.stats.duplicateSends}`,
    );
  }
  const head = (await (await fetch(`${BASE}/api/head`)).json()) as HeadResponse;

  const here = path.dirname(fileURLToPath(import.meta.url));
  fs.mkdirSync(path.join(here, ".tmp"), { recursive: true });
  fs.writeFileSync(
    path.join(here, ".tmp", "expectations.json"),
    JSON.stringify(
      {
        stats: plan.stats,
        head,
        baseTimeMs: plan.baseTimeMs,
        durationMs: plan.durationMs,
      },
      null,
      2,
    ),
  );
  console.log(
    `[e2e setup] 灌流完成：${accepted} 接受 / ${duplicates} 去重，head ingest=${head.cursor.ingestSequence}`,
  );
}
