import { buildScript } from './script';
import { toNdjson } from '../shared/ndjson';
import type { SpanEventInput } from '../shared/contract';

/**
 * Deterministic sample stream runner. Posts the scripted incident to a running
 * server over real HTTP as several "sessions" (reconnects), each session being
 * one NDJSON batch. Between sessions we re-send the previous batch's tail to
 * emulate a reconnecting collector replaying its buffer (duplicates).
 *
 * Usage:
 *   npm run sample -- --url http://127.0.0.1:4180 --seed 1 --sessions 3
 */
interface Args {
  url: string;
  seed: number;
  sessions: number;
  print: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: 'http://127.0.0.1:4180', seed: 1, sessions: 3, print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i] ?? args.url;
    else if (a === '--seed') args.seed = Number(argv[++i] ?? args.seed);
    else if (a === '--sessions') args.sessions = Number(argv[++i] ?? args.sessions);
    else if (a === '--print') args.print = true;
  }
  return args;
}

async function post(url: string, events: SpanEventInput[]): Promise<void> {
  const res = await fetch(`${url}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: toNdjson(events),
  });
  const body = (await res.json()) as { accepted: number; duplicates: number; maxIngestSequence: number };
  // eslint-disable-next-line no-console
  console.log(
    `[sample] session posted: accepted=${body.accepted} duplicates=${body.duplicates} maxIngest=${body.maxIngestSequence}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const script = buildScript(args.seed);
  const events = script.map((s) => s.event);

  if (args.print) {
    process.stdout.write(toNdjson(events));
    return;
  }

  // Split into sessions to emulate reconnecting collectors.
  const perSession = Math.max(1, Math.ceil(events.length / args.sessions));
  let tail: SpanEventInput[] = [];
  for (let s = 0; s < args.sessions; s++) {
    const slice = events.slice(s * perSession, (s + 1) * perSession);
    if (slice.length === 0) continue;
    // Reconnect replay: re-send the previous session's last event as a duplicate.
    const batch = tail.length ? [...tail, ...slice] : slice;
    await post(args.url, batch);
    tail = slice.slice(-1);
  }
  // eslint-disable-next-line no-console
  console.log('[sample] done');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[sample] failed', err);
  process.exit(1);
});
