import { resolve } from 'path';
import { LedgerStore } from './ledgerStore';
import { createAppServer } from './httpServer';
import { ReplayService } from './replayService';
import { buildSampleStream } from './sampleStream';

interface CliOptions {
  port: number;
  host: string;
  dbPath: string;
  seed: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    port: Number(process.env.PORT ?? 5180),
    host: process.env.HOST ?? '127.0.0.1',
    dbPath: process.env.DB_PATH ?? resolve(process.cwd(), 'data/replay.db'),
    seed: process.env.SEED !== '0' && process.env.SEED !== 'false'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      options.port = Number(argv[++i]);
    } else if (arg === '--host' && argv[i + 1]) {
      options.host = argv[++i] ?? options.host;
    } else if (arg === '--db' && argv[i + 1]) {
      options.dbPath = resolve(argv[++i] ?? options.dbPath);
    } else if (arg === '--no-seed') {
      options.seed = false;
    } else if (arg === '--seed') {
      options.seed = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ledger = new LedgerStore(options.dbPath);
  const service = new ReplayService(ledger);

  if (options.seed && service.totalRecords === 0) {
    for (const batch of buildSampleStream()) {
      service.ingest(batch.events);
    }
    console.log(`[seed] inserted ${service.totalRecords} ledger records`);
  } else if (service.totalRecords > 0) {
    console.log(`[replay] recovered ${service.totalRecords} ledger records from ${options.dbPath}`);
  }

  const staticDir = resolve(__dirname, '../client');
  const app = createAppServer({ service, port: options.port, host: options.host, staticDir });
  const address = await app.listen();
  console.log(`[replay] listening on http://${address.address}:${address.port}`);
  console.log(`[replay] sqlite ledger at ${options.dbPath}`);

  const shutdown = () => {
    console.log('\n[replay] shutting down');
    app.close()
      .then(() => service.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
