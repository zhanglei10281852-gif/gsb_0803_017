import { flattenSampleStream } from '../../src/server/sampleStream';

async function postNdjson(url: string, events: readonly { contractVersion: number }[]): Promise<void> {
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body
  });
  if (!res.ok) throw new Error(`seed ingest failed: ${res.status} ${await res.text()}`);
}

export default async function globalSetup(): Promise<void> {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5181';
  const events = flattenSampleStream();
  await postNdjson(`${base}/api/ingest`, events);

  const health = await (await fetch(`${base}/api/health`)).json() as { ledgerTotalRecords: number };
  if (health.ledgerTotalRecords < events.length) {
    throw new Error(`ledger only has ${health.ledgerTotalRecords} records after seed`);
  }
}
