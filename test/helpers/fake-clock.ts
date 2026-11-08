/**
 * Test helpers for the monitor suites: a fully deterministic `Clock`.
 *
 * Timers are stored with their due time and fired synchronously by
 * `advance()`/`advanceTo()`; async work started by a timer needs a
 * `flush()` afterwards so its microtasks settle.
 */
import type { Clock, TimeoutLike } from "@airoute/monitor";

export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimeoutLike {
    const id = ++this.#seq;
    this.timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(timer: TimeoutLike): void {
    this.timers.delete(timer.id);
  }

  /** Scheduled timers (id + due time), for cadence/jitter assertions. */
  pending(): Array<{ id: number; at: number }> {
    return [...this.timers.entries()]
      .map(([id, timer]) => ({ id, at: timer.at }))
      .sort((a, b) => a.at - b.at);
  }

  /** Fire every timer due at or before `target`, in due order. */
  advanceTo(target: number): void {
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId) as { at: number; fn: () => void };
      this.timers.delete(nextId);
      this.#now = timer.at;
      timer.fn();
    }
    this.#now = Math.max(this.#now, target);
  }

  advance(ms: number): void {
    this.advanceTo(this.#now + ms);
  }
}

/** Let pending microtasks (async cycles) settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
