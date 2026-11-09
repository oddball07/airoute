/**
 * @airoute/monitor — health/uptime tracking layer for AIRoute (Phase 2).
 *
 * - {@link MetricsStore}  — SQLite (node:sqlite) metrics + breaker state.
 * - {@link ProbeScheduler} — staggered/jittered per-source probe cadence.
 * - {@link HealthTracker} — circuit breaker facade (`healthy → degraded → cooling → down`).
 *
 * Fully offline-testable: `createInMemoryStore()` for the DB and injectable
 * `Clock`/`rng` for the scheduler. Part 2 (gateway wiring) consumes
 * `recordRequest`, `isRoutable`, `getStats` and the state-change hook.
 */
export {
  DEFAULT_AUTH_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PASSIVE_RECOVERY_STREAK,
  DEFAULT_PROBE_FAILURE_STREAK,
  DEFAULT_REQUEST_FAILURE_THRESHOLD,
  DEFAULT_REQUEST_FAILURE_WINDOW_MS,
  MAX_COOLDOWN_MS,
  HealthTracker,
  type HealthOptions,
  type HealthSnapshotRow,
  type StateChange,
} from "./health.js";
export {
  classifyError,
  outcomeToErrorKind,
  type CircuitState,
  type ErrorKind,
  type Outcome,
} from "./kinds.js";
export { realClock, type TickerClock, type TimeoutLike } from "./clock.js";
export {
  DEFAULT_CONTEXT_TARGET,
  DEFAULT_LATENCY_TARGET_MS,
  rankCandidateSpecs,
  rankModels,
  scoreModel,
  type ModelScore,
  type RankInput,
  type RankOptions,
  type ScoreBreakdown,
} from "./rank.js";
export {
  DEFAULT_PROBE_TIMEOUT_MS,
  probeOne,
} from "./probe.js";
export {
  DEFAULT_JITTER_MS,
  DEFAULT_MAX_CONCURRENT_PROBES,
  DEFAULT_PROBE_EVERY_MS,
  DEFAULT_STAGGER_MS,
  ProbeScheduler,
  type ProbeEvent,
  type ProbeSchedulerOptions,
} from "./scheduler.js";
export {
  DEFAULT_METRICS_DB_PATH,
  DEFAULT_RETENTION_MS,
  MetricsStore,
  createInMemoryStore,
  percentiles,
  statsWindowArgs,
  type BreakerStateUpsert,
  type ActivityRow,
  type FailureKindRow,
  type ModelStateRow,
  type ProbeObservation,
  type ProbeRunRow,
  type RequestEventRow,
  type RequestObservation,
  type RollupHourlyRow,
  type StatsSnapshot,
  type StatsWindow,
  type UptimeBucketRow,
} from "./store.js";
