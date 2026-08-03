import { EventEmitter } from "node:events";
import http from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ReplayStore } from "./store.js";
import { attachWs } from "./ws.js";

const config = loadConfig(process.argv.slice(2));
const store = new ReplayStore(config.dbPath);
const verify = store.verifyProjection();
console.log(
  `[store] db=${config.dbPath} 投影校验${verify.ok ? "一致" : "失配→已从账本重建"} checksum=${verify.checksum.slice(0, 12)}`,
);

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const app = createApp({ store, emitter, webDist: config.webDist });
const server = http.createServer(app);
attachWs(server, store, emitter);

server.listen(config.port, () => {
  console.log(`[server] 链路事故回放平台已启动：http://127.0.0.1:${config.port}`);
  console.log(`[server] 灌入确定性样例流：另开终端运行 npm run sample`);
});

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  console.log("\n[server] 正在退出…");
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // 兜底：连接未排空时最多等 1.5s
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
