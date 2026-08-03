import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  port: number;
  dbPath: string;
  webDist: string;
  packageRoot: string;
}

export function loadConfig(argv: readonly string[]): ServerConfig {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let port = Number(process.env.PORT ?? 8317);
  let dbPath = process.env.REPLAY_DB_PATH ?? path.join(packageRoot, "data", "replay.db");
  let webDist = process.env.WEB_DIST ?? path.resolve(packageRoot, "..", "web", "dist");

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      i += 1;
      port = Number(argv[i]);
    } else if (a === "--db") {
      i += 1;
      dbPath = path.resolve(String(argv[i]));
    } else if (a === "--web-dist") {
      i += 1;
      webDist = path.resolve(String(argv[i]));
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`非法端口：${String(port)}`);
  }
  return { port, dbPath, webDist, packageRoot };
}
