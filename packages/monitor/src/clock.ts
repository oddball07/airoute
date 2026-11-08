/**
 * Injectable clock seam. The probe scheduler and the health tracker run all
 * their timers/reads through a `Clock`, so tests drive them with a fake —
 * no real waiting, fully offline.
 */

/** Opaque timer handle returned by `Clock.setTimeout`. */
export interface TimeoutLike {
  /** Opaque id (diagnostics only). */
  readonly id: number;
}

export interface Clock {
  /** Wall time in ms epoch. */
  now(): number;
  /** Schedule `fn` after `ms` milliseconds. */
  setTimeout(fn: () => void, ms: number): TimeoutLike;
  /** Cancel a timer scheduled by this clock (no-op for unknown handles). */
  clearTimeout(timer: TimeoutLike): void;
}

/**
 * The scheduler-facing name for the clock seam (`Clock` is the structural
 * type; `TickerClock` reads better at call sites). Identical on purpose.
 */
export type TickerClock = Clock;

const REAL_HANDLES = new WeakMap<TimeoutLike, NodeJS.Timeout>();
let realHandleSeq = 0;

/**
 * Default real implementation backed by `setTimeout`/`clearTimeout`.
 * Timers scheduled through it are `.unref()`-ed so they never keep the
 * process (or a test run) alive on their own.
 */
export const realClock: Clock = {
  now: (): number => Date.now(),
  setTimeout(fn: () => void, ms: number): TimeoutLike {
    const timer = setTimeout(fn, ms);
    timer.unref();
    const handle: TimeoutLike = { id: ++realHandleSeq };
    REAL_HANDLES.set(handle, timer);
    return handle;
  },
  clearTimeout(timer: TimeoutLike): void {
    const real = REAL_HANDLES.get(timer);
    REAL_HANDLES.delete(timer);
    if (real !== undefined) clearTimeout(real);
  },
};
