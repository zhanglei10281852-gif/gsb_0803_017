import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(__dirname, '..', '..');

export interface RunningServer {
  baseUrl: string;
  port: number;
  dbPath: string;
  stop: () => Promise<void>;
}

/**
 * Boot the *built* server (dist/server/main.js) with a fresh SQLite database,
 * serving the built web bundle. This is the same entry point as `npm start`,
 * so E2E exercises real HTTP, websockets and static hosting.
 */
export async function startServer(opts: { dbPath?: string; port?: number } = {}): Promise<RunningServer> {
  const port = opts.port ?? 4000 + Math.floor(Math.random() * 500);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const dbPath = opts.dbPath ?? join(dir, 'ledger.sqlite');

  const child: ChildProcess = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      WEB_DIR: resolve(ROOT, 'web', 'dist'),
    },
    stdio: 'pipe',
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[srv] ${d.toString()}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[srv:err] ${d.toString()}`));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const stop = async (): Promise<void> => {
    if (!child.killed) {
      child.kill();
      await new Promise<void>((res) => {
        child.on('exit', () => res());
        setTimeout(() => res(), 4000);
      });
    }
    // Only remove the temp dir we created (not a caller-supplied dbPath).
    if (!opts.dbPath) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };

  return { baseUrl, port, dbPath, stop };
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(250);
  }
  throw new Error(`server at ${baseUrl} did not become healthy in time`);
}
