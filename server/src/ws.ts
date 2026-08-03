import type { EventEmitter } from "node:events";
import type http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseWsClientMessage,
  type InvestigationSessionV1,
  type LedgerEntryV1,
  type WsServerMessageV1,
} from "@replay/shared";
import type { ReplayStore } from "./store.js";

/**
 * WS 通道：客户端带 ?since=N 连接，先补发 N 之后的全部账本条目，
 * 再进入实时推送。补发期间的新写入先缓冲、去重后再发，保证不重不漏。
 * 客户端可发 subscribe-session 订阅会话状态广播（重连后需重新订阅）。
 */
export function attachWs(server: http.Server, store: ReplayStore, emitter: EventEmitter): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const sessionSubs = new Map<WebSocket, string | null>();

  emitter.on("session", (state: InvestigationSessionV1) => {
    const msg: WsServerMessageV1 = { contract: "ws/1", kind: "session-state", state };
    const raw = JSON.stringify(msg);
    for (const [socket, sessionId] of sessionSubs) {
      if (sessionId === state.sessionId && socket.readyState === WebSocket.OPEN) {
        socket.send(raw);
      }
    }
  });

  wss.on("connection", (socket: WebSocket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const sinceRaw = Number(url.searchParams.get("since") ?? 0);
    const since = Number.isInteger(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

    const send = (msg: WsServerMessageV1): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };

    const head = store.head();
    send({ contract: "ws/1", kind: "hello", head: head.cursor, totalEntries: head.totalEntries });

    let catchingUp = true;
    let lastSent = since;
    const buffer: LedgerEntryV1[] = [];
    const onEntry = (e: LedgerEntryV1): void => {
      if (catchingUp) {
        buffer.push(e);
      } else if (e.ingestSequence > lastSent) {
        lastSent = e.ingestSequence;
        send({ contract: "ws/1", kind: "entry", entry: e });
      }
    };
    emitter.on("entry", onEntry);

    socket.on("message", (data: Buffer) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseWsClientMessage(raw);
      if (!msg.ok) return;
      sessionSubs.set(socket, msg.value.sessionId);
    });

    for (const e of store.entriesSince(since, 50_000)) {
      lastSent = e.ingestSequence;
      send({ contract: "ws/1", kind: "entry", entry: e });
    }
    catchingUp = false;
    for (const e of buffer) {
      if (e.ingestSequence > lastSent) {
        lastSent = e.ingestSequence;
        send({ contract: "ws/1", kind: "entry", entry: e });
      }
    }
    send({ contract: "ws/1", kind: "live", head: store.head().cursor });

    socket.on("close", () => {
      emitter.off("entry", onEntry);
      sessionSubs.delete(socket);
    });
  });
}
