import type { ReplayEngine } from './replay.js';
import { generateSampleStream, type SampleEvent } from './sampleStream.js';

export class SampleRunner {
  private engine: ReplayEngine;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private scheduled: SampleEvent[] = [];

  constructor(engine: ReplayEngine) {
    this.engine = engine;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(baseTime?: number): number {
    if (this.running) return this.scheduled.length;
    const base = baseTime ?? Date.now();
    this.scheduled = generateSampleStream(base);
    this.running = true;

    for (const ev of this.scheduled) {
      const timer = setTimeout(() => {
        if (!this.running) return;
        this.engine.ingest(ev.event);
      }, ev.ingestAfterMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.push(timer);
    }
    return this.scheduled.length;
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
