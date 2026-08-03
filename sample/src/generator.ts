import type { SpanEventV1, SpanStatus } from "@replay/shared";

/**
 * 确定性样例流：同一种子永远生成字节级一致的发送计划。
 * 内含：正常拓扑流量、payments 事故（迟到错误修订）、auth 修订（脱敏）、
 * 乱序投递、重复投递、collector-pay 断线重连（重发最近 25 条）。
 */

export interface SampleSend {
  sendAtMs: number;
  event: SpanEventV1;
  kind: "original" | "duplicate" | "reconnect-resend";
}

export interface IncidentSpan {
  traceId: string;
  spanId: string;
  service: string;
  finalRevision: number;
  finalStatus: SpanStatus;
}

export interface SampleStats {
  totalSends: number;
  uniqueEvents: number;
  duplicateSends: number;
  outOfOrderPairs: number;
  reconnect: {
    producerId: string;
    gapStartOffsetMs: number;
    gapEndOffsetMs: number;
    delayedCount: number;
    resentCount: number;
  };
  revisedSpanCount: number;
  incidentSpans: IncidentSpan[];
}

export interface SamplePlan {
  seed: string;
  baseTimeMs: number;
  durationMs: number;
  sends: SampleSend[];
  stats: SampleStats;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SpanTemplate {
  service: string;
  operation: string;
  parent: number | null;
  offsetMs: number;
  minDur: number;
  maxDur: number;
  producer: string;
}

const TEMPLATE: readonly SpanTemplate[] = [
  { service: "gateway", operation: "GET /checkout", parent: null, offsetMs: 0, minDur: 60, maxDur: 140, producer: "collector-edge" },
  { service: "web-api", operation: "CheckoutHandler", parent: 0, offsetMs: 8, minDur: 50, maxDur: 120, producer: "collector-edge" },
  { service: "auth", operation: "VerifyToken", parent: 1, offsetMs: 14, minDur: 12, maxDur: 40, producer: "collector-core" },
  { service: "orders", operation: "CreateOrder", parent: 1, offsetMs: 20, minDur: 30, maxDur: 90, producer: "collector-core" },
  { service: "inventory", operation: "ReserveStock", parent: 3, offsetMs: 26, minDur: 10, maxDur: 30, producer: "collector-pay" },
  { service: "payments", operation: "ChargeCard", parent: 3, offsetMs: 30, minDur: 15, maxDur: 60, producer: "collector-pay" },
  { service: "notify", operation: "EnqueueEmail", parent: 1, offsetMs: 70, minDur: 5, maxDur: 15, producer: "collector-edge" },
];

const INCIDENT_START_MS = 95_000;
const INCIDENT_END_MS = 150_000;
const RECONNECT_PRODUCER = "collector-pay";
const GAP_START_MS = 118_000;
const GAP_END_MS = 124_000;
const RESEND_COUNT = 25;

export function generateSample(seed = "gsb-017"): SamplePlan {
  const rng = mulberry32(hashSeed(seed));
  const baseTimeMs = 1_735_000_000_000;
  const durationMs = 180_000;

  const producerCounters = new Map<string, number>();
  const nextEventId = (producer: string): string => {
    const n = (producerCounters.get(producer) ?? 0) + 1;
    producerCounters.set(producer, n);
    return `e-${n}`;
  };

  interface Pending {
    event: SpanEventV1;
    sendAtMs: number;
  }
  const pendings: Pending[] = [];
  const incidentSpans: IncidentSpan[] = [];
  const revisedKeys = new Set<string>();

  let traceN = 0;
  let t = 500 + rng() * 500;
  while (t < durationMs) {
    traceN += 1;
    const traceId = `tr-${String(traceN).padStart(4, "0")}`;
    const traceStart = baseTimeMs + t;

    for (let i = 0; i < TEMPLATE.length; i++) {
      const tpl = TEMPLATE[i] as SpanTemplate;
      const duration = Math.round(tpl.minDur + rng() * (tpl.maxDur - tpl.minDur));
      const eventTime = traceStart + tpl.offsetMs;
      const spanId = `sp-${traceN}-${i}`;
      const parentSpanId = tpl.parent === null ? null : `sp-${traceN}-${tpl.parent}`;
      const inIncident =
        tpl.service === "payments" && t >= INCIDENT_START_MS && t <= INCIDENT_END_MS;

      let status: SpanStatus = "ok";
      let errorMessage: string | null = null;
      if (!inIncident && tpl.service === "payments" && rng() < 0.02) {
        status = "error";
        errorMessage = "下游收单通道超时";
      }

      const event: SpanEventV1 = {
        contract: "span-event/1",
        producerId: tpl.producer,
        eventId: nextEventId(tpl.producer),
        traceId,
        spanId,
        parentSpanId,
        service: tpl.service,
        operation: tpl.operation,
        eventTime,
        durationMs: duration,
        revision: 1,
        status,
        errorMessage,
        attributes: { region: "local", host: `${tpl.service}-01` },
      };
      pendings.push({ event, sendAtMs: eventTime + duration + 50 + rng() * 850 });

      if (inIncident) {
        // 事故特征：span 起初上报 ok，数秒后迟到修订 r2 翻转为 error
        const r2: SpanEventV1 = {
          ...event,
          eventId: nextEventId(tpl.producer),
          revision: 2,
          status: "error",
          errorMessage: "下游收单通道超时（迟到修订）",
          attributes: { ...event.attributes, correction: "late-error-attribution" },
        };
        pendings.push({ event: r2, sendAtMs: eventTime + duration + 4000 + rng() * 5000 });
        revisedKeys.add(`${traceId}/${spanId}`);
        incidentSpans.push({
          traceId,
          spanId,
          service: tpl.service,
          finalRevision: 2,
          finalStatus: "error",
        });
      } else if (tpl.service === "auth" && rng() < 0.3) {
        // 常规修订：脱敏，不改变状态
        const r2: SpanEventV1 = {
          ...event,
          eventId: nextEventId(tpl.producer),
          revision: 2,
          attributes: { ...event.attributes, redacted: "true" },
        };
        pendings.push({ event: r2, sendAtMs: eventTime + duration + 2000 + rng() * 1500 });
        revisedKeys.add(`${traceId}/${spanId}`);
      }
    }
    t += 1000 + rng() * 400;
  }

  // 投递计划：先按发送时刻排序，再制造乱序 / 重复 / 重连
  const sends: SampleSend[] = pendings
    .map((p) => ({ sendAtMs: p.sendAtMs, event: p.event, kind: "original" as const }))
    .sort((a, b) => a.sendAtMs - b.sendAtMs);

  for (let i = 0; i + 1 < sends.length; i++) {
    if (rng() < 0.18) {
      const j = Math.min(sends.length - 1, i + 1 + Math.floor(rng() * 3));
      const a = sends[i] as SampleSend;
      const b = sends[j] as SampleSend;
      if (Math.abs(b.sendAtMs - a.sendAtMs) <= 1500) {
        sends[i] = b;
        sends[j] = a;
      }
    }
  }

  const withDuplicates: SampleSend[] = [];
  for (const s of sends) {
    withDuplicates.push(s);
    if (rng() < 0.04) {
      withDuplicates.push({ sendAtMs: s.sendAtMs + 60 + rng() * 200, event: s.event, kind: "duplicate" });
    }
  }

  const gapStart = baseTimeMs + GAP_START_MS;
  const gapEnd = baseTimeMs + GAP_END_MS;
  const merged: SampleSend[] = [];
  const delayed: SampleSend[] = [];
  const previousOfProducer: SampleSend[] = [];
  for (const s of withDuplicates) {
    if (s.event.producerId === RECONNECT_PRODUCER) {
      if (s.sendAtMs >= gapStart && s.sendAtMs < gapEnd) {
        delayed.push(s);
        continue;
      }
      if (s.sendAtMs < gapStart) previousOfProducer.push(s);
    }
    merged.push(s);
  }
  delayed.forEach((s, i) => {
    merged.push({ ...s, sendAtMs: gapEnd + i * 25 });
  });
  const resent = previousOfProducer.slice(-RESEND_COUNT);
  resent.forEach((s, i) => {
    merged.push({ sendAtMs: gapEnd + 800 + i * 20, event: s.event, kind: "reconnect-resend" });
  });
  merged.sort((a, b) => a.sendAtMs - b.sendAtMs);

  let outOfOrderPairs = 0;
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1] as SampleSend;
    const cur = merged[i] as SampleSend;
    if (cur.event.eventTime < prev.event.eventTime) outOfOrderPairs += 1;
  }
  const uniqueKeys = new Set(merged.map((s) => `${s.event.producerId}/${s.event.eventId}`));

  return {
    seed,
    baseTimeMs,
    durationMs,
    sends: merged,
    stats: {
      totalSends: merged.length,
      uniqueEvents: uniqueKeys.size,
      duplicateSends: merged.length - uniqueKeys.size,
      outOfOrderPairs,
      reconnect: {
        producerId: RECONNECT_PRODUCER,
        gapStartOffsetMs: GAP_START_MS,
        gapEndOffsetMs: GAP_END_MS,
        delayedCount: delayed.length,
        resentCount: resent.length,
      },
      revisedSpanCount: revisedKeys.size,
      incidentSpans,
    },
  };
}

export function planToNdjson(plan: SamplePlan): string {
  return plan.sends.map((s) => JSON.stringify(s.event)).join("\n") + "\n";
}
