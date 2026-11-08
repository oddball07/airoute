/**
 * HealthTracker — the circuit breaker facade over per-(sourceId, modelId)
 * health state.
 *
 * States and their routing meaning:
 * - `healthy`  — normal operation, fully routable.
 * - `degraded` — watch-list (recent request failures); still routable, the
 *   Phase 2 ranker penalizes it.
 * - `cooling`  — active cooldown (429/capacity flap or auth/quota problem);
 *   NOT routable until the cooldown expires (lazily evaluated on read).
 * - `down`     — probe failure streak reached the threshold; NOT routable
 *   until a successful probe AFTER the cooldown (the scheduler keeps probing
 *   every registered model) or an explicit `manualReset()`.
 *
 * Two failure families drive the breaker:
 * - REQUEST failures (passive signals): `requestFailureThreshold` failures
 *   within `requestFailureWindowMs` → degraded. A single 429/capacity or
 *   auth outcome cools immediately (see below).
 * - PROBE failures: consecutive-failure streak; the threshold promotes to
 *   `down`. Capacity/auth probes cool instead.
 *
 * Cooldown policies (all capped at `maxCooldownMs`, default 30 min):
 * - rate_limited/capacity → base `cooldownMs` doubling on every consecutive
 *   capacity-family failure: 5 min → 10 → 20 → 30 (capped). Documented live
 *   quirk: ZAI free tier flaps "temporarily overloaded" 429s; doubling keeps
 *   a flappy model discoverable without hammering it.
 * - auth (insufficient balance/quota, bad key) → flat 30 min cooldown and NO
 *   passive recovery: traffic cannot fix a quota problem; only a probe (or
 *   an operator via `manualReset`) can.
 *
 * Passive recovery: while `degraded`, `passiveRecoveryStreak` (default 3)
 * consecutive `outcome: "ok"` requests return the model to `healthy`. Any
 * failure resets the streak. Passive oks never clear `cooling`/`down`.
 *
 * All state transitions are logged (core logger, JSON lines) and emitted on
 * the `onStateChange` hook; every observation persists the row into
 * `model_state` via the MetricsStore so breaker state survives restarts.
 */
import { createLogger, type Logger } from "@airoute/core";
import { realClock, type Clock } from "./clock.js";
import { classifyError, type CircuitState, type ErrorKind } from "./kinds.js";
import type { MetricsStore, ProbeObservation, RequestObservation } from "./store.js";

/** Base cooldown for 429/capacity failures (ms). */
export const DEFAULT_COOLDOWN_MS = 300_000;
/** Initial (and flat) cooldown for auth/quota failures (ms). */
export const DEFAULT_AUTH_COOLDOWN_MS = 1_800_000;
/** Hard cap on any cooldown (ms). */
export const MAX_COOLDOWN_MS = 1_800_000;
/** Rolling window for counting request failures (ms). */
export const DEFAULT_REQUEST_FAILURE_WINDOW_MS = 600_000;
/** In-window failed requests at which a healthy model degrades. */
export const DEFAULT_REQUEST_FAILURE_THRESHOLD = 3;
/** Consecutive failed probes at which a model goes down. */
export const DEFAULT_PROBE_FAILURE_STREAK = 3;
/** Consecutive ok passive requests recovering a degraded model. */
export const DEFAULT_PASSIVE_RECOVERY_STREAK = 3;

export interface HealthOptions {
  /** Metrics store: observation writes + `model_state` persistence. */
  store: MetricsStore;
  logger?: Logger;
  /** Time source; default `realClock`. */
  clock?: Clock;
  /** Base cooldown for capacity 429s (ms); doubles on consecutive failures, capped. Default 300 000. */
  cooldownMs?: number;
  /** auth/quota cooldown (ms; flat, capped). Default 1 800 000. */
  authCooldownMs?: number;
  /** Cap for any cooldown (ms). Default 1 800 000. */
  maxCooldownMs?: number;
  /** Rolling window for counting request failures (ms). Default 600 000. */
  requestFailureWindowMs?: number;
  /** In-window failed requests that degrade a healthy model. Default 3. */
  requestFailureThreshold?: number;
  /** Consecutive failed probes that take a model down. Default 3. */
  probeFailureStreak?: number;
  /** Consecutive ok requests that passively recover a degraded model. Default 3. */
  passiveRecoveryStreak?: number;
  /** Hook fired for every breaker transition (also logged). */
  onStateChange?: (change: StateChange) => void;
}

export interface StateChange {
  sourceId: string;
  modelId: string;
  before: CircuitState;
  after: CircuitState;
  /** ms epoch of the transition. */
  at: number;
  /** Machine-readable why: `probe_success` | `cooldown_expired` | `capacity_cooling` | `auth_cooling` | `request_failure_threshold` | `probe_failure_streak` | `passive_recovery` | `manual_reset`. */
  reason: string;
}

/** Diagnostic snapshot row. */
export interface HealthSnapshotRow {
  sourceId: string;
  modelId: string;
  state: CircuitState;
  failureStreak: number;
  cooldownUntil: number;
}

interface TrackedModelState {
  state: CircuitState;
  /** Consecutive failed probes (any family; persisted). */
  failureStreak: number;
  /** Consecutive capacity-family failures (probe + request), for backoff. */
  capacityStreak: number;
  /** Consecutive ok passive requests while degraded. */
  okRequestStreak: number;
  /** ms epochs of recent failed non-capacity/non-auth requests. */
  requestFailures: number[];
  /** Active cooldown end (ms epoch), 0 = none. */
  cooldownUntil: number;
}

/** `Outcome` values belonging to the capacity/429 family (cooldown triggers). */
const CAPACITY_OUTCOMES: ReadonlySet<string> = new Set(["rate_limited", "capacity"]);

type Pair = { sourceId: string; modelId: string };

const keyFor = (sourceId: string, modelId: string): string => `${sourceId}\u0000${modelId}`;

export class HealthTracker {
  readonly #store: MetricsStore;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #cooldownMs: number;
  readonly #authCooldownMs: number;
  readonly #maxCooldownMs: number;
  readonly #requestFailureWindowMs: number;
  readonly #requestFailureThreshold: number;
  readonly #probeFailureStreak: number;
  readonly #passiveRecoveryStreak: number;
  readonly #onStateChange: ((change: StateChange) => void) | undefined;
  readonly #states = new Map<string, TrackedModelState>();

  constructor(options: HealthOptions) {
    this.#store = options.store;
    this.#logger = options.logger ?? createLogger({ scope: "airoute:monitor" });
    this.#clock = options.clock ?? realClock;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#authCooldownMs = options.authCooldownMs ?? DEFAULT_AUTH_COOLDOWN_MS;
    this.#maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
    this.#requestFailureWindowMs =
      options.requestFailureWindowMs ?? DEFAULT_REQUEST_FAILURE_WINDOW_MS;
    this.#requestFailureThreshold =
      options.requestFailureThreshold ?? DEFAULT_REQUEST_FAILURE_THRESHOLD;
    this.#probeFailureStreak = options.probeFailureStreak ?? DEFAULT_PROBE_FAILURE_STREAK;
    this.#passiveRecoveryStreak = options.passiveRecoveryStreak ?? DEFAULT_PASSIVE_RECOVERY_STREAK;
    this.#onStateChange = options.onStateChange;

    // Restore persisted breaker rows so state survives restarts. The
    // capacity backoff exponent intentionally restarts at boot (its history
    // is not persisted); the streak itself is.
    for (const row of this.#store.getBreakerStates()) {
      this.#states.set(keyFor(row.sourceId, row.modelId), {
        state: row.breaker,
        failureStreak: row.failureStreak,
        capacityStreak: 0,
        okRequestStreak: 0,
        requestFailures: [],
        cooldownUntil: row.cooldownUntil,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Observations                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Record a probe result: appends to `probe_runs` and feeds the breaker.
   * This is the single write path the scheduler uses when a tracker is
   * attached — the store write happens here, not twice.
   */
  recordProbe(observation: ProbeObservation): void {
    this.#store.recordProbe(observation);
    if (observation.ok) this.#onProbeSuccess(observation);
    else this.#onProbeFailure(observation);
  }

  /**
   * Record a passive request signal: appends to `request_events` and feeds
   * the breaker. Wired by the gateway in Phase 2 part 2.
   */
  recordRequest(observation: RequestObservation): void {
    this.#store.recordRequest(observation);
    if (observation.outcome === "ok") this.#onRequestOk(observation);
    else if (observation.outcome !== "drop") this.#onRequestFailure(observation);
    // `drop` = client disconnected mid-flight: deliberately neutral for the
    // breaker (it says nothing about the model).
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Current breaker state (cooldown expiry evaluated lazily). */
  state(sourceId: string, modelId: string): CircuitState {
    const tracked = this.#trackedFor({ sourceId, modelId });
    this.#refreshExpiry(tracked, { sourceId, modelId });
    return tracked.state;
  }

  /**
   * Routing verdict: `healthy` and `degraded` are routable (degraded is
   * penalized by the ranker), `cooling` and `down` are not.
   */
  isRoutable(sourceId: string, modelId: string): boolean {
    const state = this.state(sourceId, modelId);
    return state !== "cooling" && state !== "down";
  }

  /** ms epoch when the active cooldown ends, `0` when none. */
  cooldownExpiresAt(sourceId: string, modelId: string): number {
    const tracked = this.#trackedFor({ sourceId, modelId });
    this.#refreshExpiry(tracked, { sourceId, modelId });
    return tracked.cooldownUntil;
  }

  /** All tracked pairs with their breaker state (diagnostics / /healthz). */
  snapshot(): HealthSnapshotRow[] {
    const rows: HealthSnapshotRow[] = [];
    for (const [key, tracked] of this.#states) {
      const [sourceId, modelId] = splitKey(key);
      const pair = { sourceId, modelId };
      this.#refreshExpiry(tracked, pair);
      rows.push({
        sourceId,
        modelId,
        state: tracked.state,
        failureStreak: tracked.failureStreak,
        cooldownUntil: tracked.cooldownUntil,
      });
    }
    rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.modelId.localeCompare(b.modelId));
    return rows;
  }

  /**
   * Manual refresh: clear the breaker for one pair (back to `healthy`, zero
   * streaks, no cooldown). The operator path for `down` models.
   */
  manualReset(sourceId: string, modelId: string): void {
    const tracked = this.#trackedFor({ sourceId, modelId });
    this.#refreshExpiry(tracked, { sourceId, modelId });
    this.#transition(tracked, { sourceId, modelId }, "healthy", "manual_reset");
    tracked.failureStreak = 0;
    tracked.capacityStreak = 0;
    tracked.okRequestStreak = 0;
    tracked.requestFailures = [];
    tracked.cooldownUntil = 0;
    this.#persist({ sourceId, modelId }, tracked);
  }

  /* ---------------------------------------------------------------------- */
  /* Probe handling                                                         */
  /* ---------------------------------------------------------------------- */

  #onProbeSuccess(observation: ProbeObservation): void {
    const pair = { sourceId: observation.sourceId, modelId: observation.modelId };
    const tracked = this.#trackedFor(pair);
    this.#refreshExpiry(tracked, pair);

    // A successful probe is the strongest health signal: healthy from any
    // state except `down` still inside its cooldown (that requires the
    // cooldown to expire first — conservative-on-purpose).
    if (tracked.state === "down" && tracked.cooldownUntil > this.#clock.now()) {
      // Too early to trust: stay down until expiry (then the next success
      // or manualReset heals it). Streak untouched.
      return;
    }
    if (tracked.state !== "healthy") {
      this.#transition(tracked, pair, "healthy", "probe_success");
    }
    tracked.failureStreak = 0;
    tracked.capacityStreak = 0;
    tracked.cooldownUntil = 0;
    this.#persist(pair, tracked);
  }

  #onProbeFailure(observation: ProbeObservation): void {
    const pair = { sourceId: observation.sourceId, modelId: observation.modelId };
    const tracked = this.#trackedFor(pair);
    const now = this.#clock.now();
    this.#refreshExpiry(tracked, pair);

    const kind = observation.errorKind ?? classifyError(observation.errorDetail);
    if (kind === "rate_limited" || kind === "capacity") {
      tracked.failureStreak += 1;
      tracked.capacityStreak += 1;
      tracked.cooldownUntil = now + this.#capacityCooldown(tracked.capacityStreak);
      this.#transition(tracked, pair, "cooling", "capacity_cooling");
      this.#persist(pair, tracked);
      return;
    }
    if (kind === "auth") {
      tracked.failureStreak += 1;
      tracked.cooldownUntil = now + Math.min(this.#authCooldownMs, this.#maxCooldownMs);
      this.#transition(tracked, pair, "cooling", "auth_cooling");
      this.#persist(pair, tracked);
      return;
    }

    // server | network | timeout | unknown failures — streak toward `down`.
    tracked.failureStreak += 1;
    if (tracked.failureStreak >= this.#probeFailureStreak) {
      tracked.cooldownUntil = now + this.#downCooldown(tracked.failureStreak);
      this.#transition(tracked, pair, "down", "probe_failure_streak");
    }
    this.#persist(pair, tracked);
  }

  /* ---------------------------------------------------------------------- */
  /* Request handling                                                       */
  /* ---------------------------------------------------------------------- */

  #onRequestOk(observation: RequestObservation): void {
    const pair = { sourceId: observation.sourceId, modelId: observation.modelId };
    const tracked = this.#trackedFor(pair);
    this.#refreshExpiry(tracked, pair);

    // Passive recovery only while degraded. oks during cooling/down must
    // NOT heal (cooldowns end through expiry + probe confirmation).
    if (tracked.state === "degraded") {
      tracked.okRequestStreak += 1;
      if (tracked.okRequestStreak >= this.#passiveRecoveryStreak) {
        this.#transition(tracked, pair, "healthy", "passive_recovery");
        tracked.okRequestStreak = 0;
      }
    }
    this.#persist(pair, tracked);
  }

  #onRequestFailure(observation: RequestObservation): void {
    const pair = { sourceId: observation.sourceId, modelId: observation.modelId };
    const tracked = this.#trackedFor(pair);
    const now = this.#clock.now();
    this.#refreshExpiry(tracked, pair);

    const kind = this.#kindForRequest(observation);
    tracked.okRequestStreak = 0;

    // 429/capacity and auth failures cool immediately (single-flap cooldown
    // policy — see the header comment).
    if (CAPACITY_OUTCOMES.has(kind)) {
      tracked.capacityStreak += 1;
      tracked.cooldownUntil = now + this.#capacityCooldown(tracked.capacityStreak);
      this.#transition(tracked, pair, "cooling", "capacity_cooling");
      this.#persist(pair, tracked);
      return;
    }
    if (kind === "auth") {
      tracked.cooldownUntil = now + Math.min(this.#authCooldownMs, this.#maxCooldownMs);
      this.#transition(tracked, pair, "cooling", "auth_cooling");
      this.#persist(pair, tracked);
      return;
    }

    // server | network | timeout | unknown: count within the rolling window.
    tracked.requestFailures.push(observation.ts ?? now);
    while (
      tracked.requestFailures.length > 0 &&
      (tracked.requestFailures[0] as number) <= now - this.#requestFailureWindowMs
    ) {
      tracked.requestFailures.shift();
    }
    if (
      tracked.state === "healthy" &&
      tracked.requestFailures.length >= this.#requestFailureThreshold
    ) {
      this.#transition(tracked, pair, "degraded", "request_failure_threshold");
    }
    this.#persist(pair, tracked);
  }

  #kindForRequest(observation: RequestObservation): ErrorKind {
    if (observation.errorKind !== undefined) return observation.errorKind;
    // Failure outcomes are already ErrorKind values ("ok"/"drop" never get here).
    return observation.outcome as ErrorKind;
  }

  /* ---------------------------------------------------------------------- */
  /* State machine mechanics                                                */
  /* ---------------------------------------------------------------------- */

  /** Fetch (creating defaults) the tracked state for one pair. */
  #trackedFor(pair: Pair): TrackedModelState {
    const key = keyFor(pair.sourceId, pair.modelId);
    let tracked = this.#states.get(key);
    if (tracked === undefined) {
      tracked = {
        state: "healthy",
        failureStreak: 0,
        capacityStreak: 0,
        okRequestStreak: 0,
        requestFailures: [],
        cooldownUntil: 0,
      };
      this.#states.set(key, tracked);
    }
    return tracked;
  }

  /** Lazy cooldown expiry: cooling → healthy once `now` passes the deadline. */
  #refreshExpiry(tracked: TrackedModelState, pair: Pair): void {
    if (tracked.state === "cooling" && tracked.cooldownUntil > 0) {
      if (this.#clock.now() >= tracked.cooldownUntil) {
        this.#transition(tracked, pair, "healthy", "cooldown_expired");
      }
    }
  }

  #transition(tracked: TrackedModelState, pair: Pair, after: CircuitState, reason: string): void {
    const before = tracked.state;
    if (before === after) return;
    tracked.state = after;
    const change: StateChange = { ...pair, before, after, at: this.#clock.now(), reason };
    this.#logTransition(change);
    this.#onStateChange?.(change);
  }

  #logTransition(change: StateChange): void {
    const data = {
      sourceId: change.sourceId,
      modelId: change.modelId,
      from: change.before,
      to: change.after,
      reason: change.reason,
    };
    if (change.after === "down") this.#logger.warn("model marked down", data);
    else if (change.after === "cooling") this.#logger.warn("model cooling down", data);
    else if (change.after === "degraded") this.#logger.warn("model degraded", data);
    else this.#logger.info("model recovered", data);
  }

  #persist(pair: Pair, tracked: TrackedModelState): void {
    this.#store.setBreakerState({
      sourceId: pair.sourceId,
      modelId: pair.modelId,
      breaker: tracked.state,
      failureStreak: tracked.failureStreak,
      cooldownUntil: tracked.cooldownUntil,
      updatedAt: this.#clock.now(),
    });
  }

  /** Cooldown for capacity-family failure #streak (1-based): doubling, capped. */
  #capacityCooldown(streak: number): number {
    const backoff = this.#cooldownMs * Math.pow(2, Math.max(0, streak - 1));
    return Math.min(backoff, this.#maxCooldownMs);
  }

  /** Cooldown set when a `down` transition happens at the given streak. */
  #downCooldown(streak: number): number {
    const backoff =
      this.#cooldownMs * Math.pow(2, Math.max(0, streak - this.#probeFailureStreak));
    return Math.min(backoff, this.#maxCooldownMs);
  }
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf("\u0000");
  const sourceId = index === -1 ? key : key.slice(0, index);
  const modelId = index === -1 ? "" : key.slice(index + 1);
  return [sourceId, modelId];
}
