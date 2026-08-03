import { resolve } from 'node:path';
import { buildApp } from './app';

const PORT = Number(process.env.PORT ?? 4180);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? resolve(process.cwd(), 'data', 'ledger.sqlite');
const WEB_DIR = process.env.WEB_DIR ?? resolve(process.cwd(), 'web', 'dist');

async function main(): Promise<void> {
  const { app } = buildApp({ dbPath: DB_PATH, webDir: WEB_DIR });
  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`[replay] listening on http://${HOST}:${PORT}  db=${DB_PATH}`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[replay] fatal', err);
  process.exit(1);
});
