import { buildSampleStream } from '../server/sampleStream';

interface CliOptions {
  url: string;
  delayMs: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    url: process.env.INGEST_URL ?? 'http://127.0.0.1:5180/api/ingest',
    delayMs: Number(process.env.SAMPLE_DELAY_MS ?? 400)
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) {
      options.url = argv[++i] ?? options.url;
    } else if (arg === '--delay-ms' && argv[i + 1]) {
      options.delayMs = Number(argv[++i]);
    }
  }
  return options;
}

async function postNdjson(url: string, events: readonly { contractVersion: number }[]): Promise<void> {
  const body = events.map((event) => JSON.stringify(event)).join('\n');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body
  });
  const text = await response.text();
  console.log(`[sample] ${response.status} ${text}`);
  if (!response.ok) {
    throw new Error(`ingest failed: ${response.status} ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const batches = buildSampleStream();
  console.log(`[sample] sending ${batches.length} batches to ${options.url}`);
  for (const batch of batches) {
    if (batch.reconnect) {
      console.log(`[sample] --- simulated collector reconnect before: ${batch.label}`);
      await sleep(options.delayMs * 2);
    }
    console.log(`[sample] >>> ${batch.label} (${batch.events.length} events)`);
    await postNdjson(options.url, batch.events);
    await sleep(options.delayMs);
  }
  console.log('[sample] done');
}

main().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
