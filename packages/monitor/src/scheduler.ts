/**
 * ProbeScheduler — drives the per-source probe cadence.
 *
 * Design goals (the "one invoice" rule):
 * - One timer per source; never parallel-probes the same model.
 * - Sources stagger their first fire (`staggerMs * index`, + jitter) so boot
 *   does not fan out against every provider at once.
 * - Steady cadence per source: `probeEveryMs + rng() * jitterMs`.
 * - A cycle that still runs when its next tick fires SKIPS that tick (warn)
 *   instead of overlapping; the following tick simply runs next.
 * - A global `maxConcurrentProbes` cap (default 1): a cycle that fires while
 *   another source's cycle is mid-probe is skipped for this tick (warn) —
 *   the model is rare and cheap to defer.
 *
 * The monitor package does not depend on `SourceRegistry` — it accepts plain
 * `Source[]` (or a custom models fetcher). Each cycle: `listModels()` once
 * (last-good cached on failure), then `probeOne()` per model sequentially,
 * classifying and recording every result (MetricsStore, circuit breaker,
 * `onProbe` hook).
 */
import type { Logger, ModelSpec, ProbeResult, Source } from "@airoute/core";
import { createLogger } from "@airoute/core";
import { realClock, type Clock } from "./clock.js";
import type { ErrorKind } from "./kinds.js";
import { classifyError } from "./kinds.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeOne } from "./probe.js";
import type { HealthTracker } from "./health.js";
import type { MetricsStore, ProbeObservation } from "./store.js";

/** Default per-source probe cadence (15 min). */
export const DEFAULT_PROBE_EVERY_MS = 900_000;
/** Default random jitter added to every cadence (max 1 min). */
export const DEFAULT_JITTER_MS = 60_000;
/** Default per-source start stagger. */
export const DEFAULT_STAGGER_MS = 500;
/** Per-probe timeout lives in `probe.ts` with `probeOne`; re-exported here. */
export { DEFAULT_PROBE_TIMEOUT_MS } from "./probe.js";
/** Default global cap on probes in flight. */
export const DEFAULT_MAX_CONCURRENT_PROBES = 1;

export interface ProbeSchedulerOptions {
  /** Metrics store used when no `health` tracker is attached. */
  store: MetricsStore;
  /** Attached tracker (records probe + feeds breaker in one call). */
  health?: HealthTracker;
  /** Injectable clock; default `realClock`. */
  clock?: Clock;
  /** Injectable RNG for jitter bounds, default `Math.random`. */
  rng?: () => number;
  logger?: Logger;
  /** Base cadence per source (ms); must be >= 1. Default 900 000. */
  probeEveryMs?: number;
  /** Max random jitter on every cadence (ms) >= 0. Default 60 000. */
  jitterMs?: number;
  /** Start stagger between registered sources (ms). Default 500. */
  staggerMs?: number;
  /** Per-probe timeout (ms). Default 30 000. */
  probeTimeoutMs?: number;
  /** Global cap on probes in flight. Default 1. */
  maxConcurrentProbes?: number;
  /** Fired after each recorded probe. */
  onProbe?: (event: ProbeEvent) => void;
  /**
   * Optional injected models fetcher; defaults to `source.listModels()`.
   * Return `[]` to skip the source this cycle.
   */
  models?: (source: Source) => Promise<ModelSpec[]> | ModelSpec[];
}

export interface ProbeEvent {
  sourceId: string;
  /** The probed model spec (`spec.id` is the gateway-level model id). */
  spec: ModelSpec;
  probe: ProbeResult;
  /** Classified failure family; unset for successful probes. */
  errorKind?: ErrorKind;
  /** ms epoch when the probe was recorded. */
  at: number;
}

interface SourceEntry {
  source: Source;
  timer: ReturnType<Clock["setTimeout"]> | undefined;
  /** A cycle is mid-flight (probe(s) not yet done). */
  busy: boolean;
  /** Last-good model list served when `listModels()` fails. */
  lastModels: ModelSpec[] | undefined;
}

export class ProbeScheduler {
  readonly #store: MetricsStore;
  readonly #health: HealthTracker | undefined;
  readonly #clock: Clock;
  readonly #rng: () => number;
  readonly #logger: Logger;
  readonly #onProbe: ((event: ProbeEvent) => void) | undefined;
  readonly #models: (source: Source) => Promise<ModelSpec[]> | ModelSpec[];
  readonly #probeEveryMs: number;
  readonly #jitterMs: number;
  readonly #staggerMs: number;
  readonly #probeTimeoutMs: number;
  readonly #maxConcurrentProbes: number;
  readonly #entries: SourceEntry[] = [];
  #running = false;
  #closed = false;
  #probesInFlight = 0;

  constructor(options: ProbeSchedulerOptions) {
    this.#store = options.store;
    this.#health = options.health;
    this.#clock = options.clock ?? realClock;
    this.#rng = options.rng ?? Math.random;
    this.#logger = options.logger ?? createLogger({ scope: "airoute:monitor" });
    this.#onProbe = options.onProbe;
    this.#models = options.models ?? ((source) => source.listModels());
    this.#probeEveryMs = options.probeEveryMs ?? DEFAULT_PROBE_EVERY_MS;
    this.#jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
    this.#staggerMs = options.staggerMs ?? DEFAULT_STAGGER_MS;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#maxConcurrentProbes = options.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES;
    if (!Number.isInteger(this.#probeEveryMs) || this.#probeEveryMs < 1) {
      throw new Error("probeEveryMs must be a positive integer");
    }
    if (!Number.isInteger(this.#jitterMs) || this.#jitterMs < 0) {
      throw new Error("jitterMs must be a non-negative integer");
    }
  }

  /** Scheduled but not yet fired timers (diagnostics + tests). */
  get pendingTimerCount(): number {
    return this.#entries.filter((entry) => entry.timer !== undefined).length;
  }

  /**
   * Register sources. Safe after `start()` too — new sources pick up with
   * the standard stagger appended behind the already-scheduled ones.
   */
  registerSources(sources: readonly Source[]): this {
    const baseIndex = this.#entries.length;
    for (const [offset, source] of sources.entries()) {
      this.#entries.push({ source, timer: undefined, busy: false, lastModels: undefined });
      if (this.#running) {
        this.#schedule(this.#entries[baseIndex + offset] as SourceEntry, offset * this.#staggerMs);
      }
    }
    return this;
  }

  /** Begin scheduling. Idempotent while running; throws after `close()`. */
  start(): void {
    if (this.#closed) throw new Error("ProbeScheduler is closed");
    if (this.#running) return;
    this.#running = true;
    this.#entries.forEach((entry, index) => this.#schedule(entry, index * this.#staggerMs));
  }

  /** Cancel all pending timers. In-flight probes may still complete. */
  stop(): void {
    this.#running = false;
    for (const entry of this.#entries) {
      if (entry.timer !== undefined) {
        this.#clock.clearTimeout(entry.timer);
        entry.timer = undefined;
      }
    }
  }

  /** `stop()` plus permanent close: `start()` throws afterwards. */
  close(): void {
    this.stop();
    this.#closed = true;
  }

  /* ---------------------------------------------------------------------- */
  /* Scheduling mechanics                                                   */
  /* ---------------------------------------------------------------------- */

  /** Arm the next timer for one entry: `delayMs + rng() * jitterMs`. */
  #schedule(entry: SourceEntry, delayMs: number): void {
    if (!this.#running) return;
    const jitter = this.#jitterMs > 0 ? this.#rng() * this.#jitterMs : 0;
    const delay = Math.max(0, delayMs + jitter);
    entry.timer = this.#clock.setTimeout(() => this.#onTimer(entry), delay);
  }

  #onTimer(entry: SourceEntry): void {
    if (!this.#running) return;
    // Perpetuate the cadence FIRST so probes that resolve quickly keep a
    // stable rhythm regardless of how long this tick takes.
    this.#schedule(entry, this.#probeEveryMs);

    if (entry.busy) {
      // Long-overrun skip: the previous cycle still runs; never overlap it.
      this.#logger.warn(`probe cycle for '${entry.source.id}' still running; skipping this tick`);
      return;
    }
    if (this.#probesInFlight >= this.#maxConcurrentProbes) {
      this.#logger.warn(
        `probe skipped for '${entry.source.id}': already at max concurrent probes (${this.#maxConcurrentProbes})`,
      );
      return;
    }
    entry.busy = true;
    this.#probesInFlight += 1;
    void this.#runCycle(entry).catch((err: unknown) => {
      this.#logger.warn(`probe cycle for '${entry.source.id}' crashed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** One cycle: fetch models, then probe each sequentially. */
  async #runCycle(entry: SourceEntry): Promise<void> {
    try {
      let models: ModelSpec[] | undefined;
      let fetchError: string | undefined;
      try {
        models = await this.#models(entry.source);
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
        models = entry.lastModels;
      }
      if (models === undefined) {
        this.#logger.warn(`source '${entry.source.id}' failed to list models; skipping this cycle`, {
          error: fetchError,
        });
        return;
      }
      entry.lastModels = models;
      models = [...models]; // defensive snapshot

      for (const spec of models) {
        if (!this.#running) return; // stopped mid-cycle: stop writing
        const probe = await probeOne(entry.source, spec, this.#probeTimeoutMs);
        const at = this.#clock.now();
        if (probe.ok) {
          this.#record({ sourceId: entry.source.id, modelId: spec.id, ok: true, latencyMs: probe.latencyMs, ts: at, at: new Date(at).toISOString() });
          this.#onProbe?.({ sourceId: entry.source.id, spec, probe, at });
        } else {
          const errorKind = classifyError(probe.error);
          this.#record({
            sourceId: entry.source.id,
            modelId: spec.id,
            ok: false,
            latencyMs: probe.latencyMs,
            errorKind,
            errorDetail: probe.error,
            ts: at,
            at: new Date(at).toISOString(),
          });
          this.#onProbe?.({ sourceId: entry.source.id, spec, probe, errorKind, at });
        }
      }
    } finally {
      entry.busy = false;
      this.#probesInFlight -= 1;
    }
  }

  /** Single write path: through the health tracker when attached. */
  #record(observation: ProbeObservation): void {
    if (this.#health !== undefined) this.#health.recordProbe(observation);
    else this.#store.recordProbe(observation);
  }
}
