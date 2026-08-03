import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

export function tempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `trace-replay-${label}-`));
  return join(dir, 'ledger.db');
}

export function cleanupPath(dbPath: string): void {
  try {
    rmSync(dbPath.slice(0, dbPath.lastIndexOf('\\') > 0 ? dbPath.lastIndexOf('\\') : dbPath.lastIndexOf('/') + 1), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
