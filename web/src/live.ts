import { parseWsServerMessage, type InvestigationSessionV1, type WsClientMessageV1 } from "@replay/shared";
import type { ReplayStore } from "./state.js";

function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** WS 连接管理：断开自动重连，带 since 断点续传；会话订阅在重连后自动恢复。 */
export class LiveConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private sessionId: string | null = null;

  /** 会话状态广播回调（由 CollabClient 挂接）。 */
  onSessionState: ((state: InvestigationSessionV1) => void) | null = null;

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

  /** 订阅/退订会话广播；连接建立后会自动重发。 */
  setSession(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.sendSubscribe();
  }

  private sendSubscribe(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: WsClientMessageV1 = {
        contract: "ws-client/1",
        kind: "subscribe-session",
        sessionId: this.sessionId,
      };
      ws.send(JSON.stringify(msg));
    }
  }

  private connect(): void {
    this.store.setConnection(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(`${this.url}?since=${this.store.lastSeq}`);
    ws.onopen = () => {
      this.sendSubscribe();
    };
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
      } else if (m.kind === "session-state") {
        this.onSessionState?.(m.state);
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
