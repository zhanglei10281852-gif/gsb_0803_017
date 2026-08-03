import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(here, ".tmp");

// 每次 e2e 从干净的数据库启动，保证可重复
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const child = spawn(
  process.execPath,
  [path.join(root, "server", "dist", "index.js"), "--port", "8377", "--db", path.join(tmp, "e2e.db")],
  { cwd: root, stdio: "inherit" },
);

const kill = () => {
  if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("SIGTERM", kill);
process.on("SIGINT", kill);
process.on("exit", kill);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
