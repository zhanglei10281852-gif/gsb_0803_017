import { parseWsServerMessage } from "@replay/shared";
import type { ReplayStore } from "./state.js";

function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** WS 连接管理：断开自动重连，带 since 断点续传，服务端补发缺口。 */
export class LiveConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;

  constructor(
    private readonly store: ReplayStore,
    private readonly url: string = defaultWsUrl(),
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    this.store.setConnection(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(`${this.url}?since=${this.store.lastSeq}`);
    ws.onmessage = (ev: MessageEvent<string>) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const msg = parseWsServerMessage(raw);
      if (!msg.ok) return;
      const m = msg.value;
      if (m.kind === "hello") this.store.applyHello(m.head, m.totalEntries);
      else if (m.kind === "entry") this.store.applyEntry(m.entry);
      else if (m.kind === "live") {
        this.attempts = 0;
        this.store.setConnection("live");
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.attempts += 1;
      this.store.setConnection("reconnecting");
      setTimeout(() => this.connect(), Math.min(500 * this.attempts, 5000));
    };
    ws.onerror = () => {
      ws.close();
    };
    this.ws = ws;
  }
}
