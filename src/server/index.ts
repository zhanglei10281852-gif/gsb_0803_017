import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { LedgerStore } from './db.js';
import { ReplayEngine } from './replay.js';
import { SampleRunner } from './sampleRunner.js';
import { createAppServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), 'data', 'ledger.db');

if (process.env.CLEAN_DB === '1') {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const f = DB_PATH + ext;
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, '..', 'public');

const store = new LedgerStore(DB_PATH);
const engine = new ReplayEngine(store);
const sampleRunner = new SampleRunner(engine);

const { server } = createAppServer({ engine, sampleRunner, publicDir });

server.listen(PORT, () => {
  const head = engine.getHead();
  console.log(`[trace-replay] listening on http://localhost:${PORT}`);
  console.log(`[trace-replay] ledger: ${DB_PATH} (${engine.totalRecords()} records, head seq=${head.ingestSequence}, eventTime=${head.eventTime})`);
  console.log(`[trace-replay] static: ${publicDir}`);
});

function shutdown(signal: string): void {
  console.log(`[trace-replay] received ${signal}, shutting down...`);
  sampleRunner.stop();
  server.close(() => {
    engine.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
