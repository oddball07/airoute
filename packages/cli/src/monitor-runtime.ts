/**
 * Monitor wiring shared by `airoute serve` and `airoute status`.
 *
 * `serve` opens the metrics DB, restores breaker state, starts the probe
 * scheduler (unless `monitor.enabled` is false) and exposes a ranker for alias
 * resolution/failover. `status` reuses the store + ranker read-only.
 */
import type { AirouteConfig, Logger, ModelSpec, RankWeights, Source } from "@airoute/core";
import { DEFAULT_MONITOR } from "@airoute/core";
import {
  DEFAULT_METRICS_DB_PATH,
  DEFAULT_RETENTION_MS,
  HealthTracker,
  MetricsStore,
  ProbeScheduler,
  rankCandidateSpecs,
  type RankInput,
} from "@airoute/monitor";

/** Rolling window used for ranking decisions (24 h). */
export const RANK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Order alias candidates (and thus failover order) by live health. */
export type Ranker = (candidates: readonly ModelSpec[], alias: string) => readonly ModelSpec[];

/** Metrics DB location; `AIRROUTE_DB` overrides the default `data/airoute.db`. */
export function metricsDbPath(): string {
  const override = process.env["AIRROUTE_DB"];
  return override !== undefined && override.length > 0 ? override : DEFAULT_METRICS_DB_PATH;
}

/**
 * Alias-specific preference tweaks on top of the configured weights:
 * `free-coder` values tool support, `free-fast` values latency.
 */
export function aliasWeights(alias: string, base: RankWeights): RankWeights {
  if (alias === "free-coder") {
    return { ...base, capability: base.capability + 0.3 };
  }
  if (alias === "free-fast") {
    return { ...base, latency: base.latency + 0.4 };
  }
  return base;
}

/**
 * Build a ranker over the metrics store. Passing no store/health yields a
 * neutral ordering (useful before any metrics exist, e.g. fresh `status`).
 */
export function createRanker(
  store: Pick<MetricsStore, "getStats"> | undefined,
  health: Pick<HealthTracker, "state"> | undefined,
  weights: RankWeights,
): Ranker {
  return (candidates, alias) =>
    rankCandidateSpecs(
      candidates,
      (spec): RankInput => {
        const stats = store?.getStats(spec.sourceId, spec.id, RANK_WINDOW_MS) ?? null;
        return {
          spec,
          stats,
          state: health?.state(spec.sourceId, spec.id) ?? "healthy",
          lastErrorKind: stats?.lastErrorKind ?? null,
        };
      },
      aliasWeights(alias, weights),
    );
}

export interface MonitorRuntime {
  store: MetricsStore;
  health: HealthTracker;
  scheduler: ProbeScheduler;
  ranker: Ranker;
  /** `monitor.enabled` from config. */
  enabled: boolean;
  /** Resolved metrics DB path. */
  dbPath: string;
}

/**
 * Open the metrics store, prune expired rows, restore breaker state and start
 * the probe scheduler for the enabled sources.
 */
export function startMonitor(
  config: AirouteConfig,
  sources: readonly Source[],
  logger: Logger,
): MonitorRuntime {
  const monitor = config.monitor ?? DEFAULT_MONITOR;
  const dbPath = metricsDbPath();
  const store = new MetricsStore(dbPath);

  const pruned = store.retainOlderThan(Date.now() - DEFAULT_RETENTION_MS);
  if (pruned.probeRuns + pruned.requestEvents > 0) {
    logger.info("pruned old metrics", { db: dbPath, ...pruned });
  }

  const health = new HealthTracker({
    store,
    logger: logger.child("health"),
    cooldownMs: monitor.cooldownMs,
    requestFailureWindowMs: monitor.requestFailureWindowMs,
  });

  const scheduler = new ProbeScheduler({
    store,
    health,
    logger: logger.child("probe"),
    probeEveryMs: monitor.probeEveryMs,
    jitterMs: monitor.jitterMs,
  });
  scheduler.registerSources(sources);
  if (monitor.enabled) scheduler.start();

  return {
    store,
    health,
    scheduler,
    ranker: createRanker(store, health, config.rank.weights),
    enabled: monitor.enabled,
    dbPath,
  };
}

/** Close the store and stop probing (safe to call after a partial start). */
export function stopMonitor(runtime: Pick<MonitorRuntime, "store" | "scheduler">): void {
  runtime.scheduler.close();
  runtime.store.close();
}
