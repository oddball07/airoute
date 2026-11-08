/**
 * Free-model ranking (Phase 2 part 2).
 *
 * Converts a `ModelSpec` + its observed health into a 0..1 score using the
 * configured `rank.weights`. The gateway uses the resulting order for alias
 * resolution (`free-best` etc.) and upstream failover.
 *
 * Signals:
 * - `uptime`     — probe success rate, falling back to request success rate;
 *                  0.5 (neutral) when the model has no observations yet.
 * - `quota`      — penalizes recent capacity/429 and auth/quota failures;
 *                  `cooling`/`down` models score 0 and are not routable.
 * - `latency`    — inverse p50 request latency vs `latencyTargetMs`.
 * - `context`    — context window vs `contextTarget`.
 * - `capability` — weighted tools/vision/reasoning flags.
 *
 * Ranking never decides *routability* on its own beyond the breaker's
 * cooling/down verdict: it is an ordering, not an allow-list.
 */
import type { ModelSpec, RankWeights } from "@airoute/core";
import type { CircuitState, ErrorKind, Outcome } from "./kinds.js";
import type { StatsSnapshot } from "./store.js";

/** Latency (ms) at which the latency component reaches 0. */
export const DEFAULT_LATENCY_TARGET_MS = 10_000;
/** Context window (tokens) at which the context component reaches 1. */
export const DEFAULT_CONTEXT_TARGET = 200_000;

export interface RankInput {
  spec: ModelSpec;
  /** Rolling stats for the model; `null`/omitted means "no data yet". */
  stats?: StatsSnapshot | null;
  /** Current breaker state; omitted means healthy (unknown). */
  state?: CircuitState;
  /** Fallback error signal when `stats.lastErrorKind` is unavailable. */
  lastErrorKind?: ErrorKind | Outcome | null;
}

export interface ScoreBreakdown {
  uptime: number;
  quota: number;
  latency: number;
  context: number;
  capability: number;
}

export interface ModelScore {
  spec: ModelSpec;
  /** Weighted 0..1 score. */
  score: number;
  breakdown: ScoreBreakdown;
  /** `false` only for `cooling`/`down` breaker states. */
  routable: boolean;
}

export interface RankOptions {
  latencyTargetMs?: number;
  contextTarget?: number;
}

const NEUTRAL = 0.5;

/** Score one model. Pure function — same inputs always give the same score. */
export function scoreModel(
  input: RankInput,
  weights: RankWeights,
  options: RankOptions = {},
): ModelScore {
  const { spec, stats } = input;
  const state = input.state ?? "healthy";
  const routable = state !== "cooling" && state !== "down";

  const uptime =
    stats?.probeSuccessRate ?? stats?.requestSuccessRate ?? NEUTRAL;

  const latencyTarget = options.latencyTargetMs ?? DEFAULT_LATENCY_TARGET_MS;
  const latency =
    stats?.p50Ms === null || stats?.p50Ms === undefined
      ? NEUTRAL
      : clamp01(1 - stats.p50Ms / latencyTarget);

  const contextTarget = options.contextTarget ?? DEFAULT_CONTEXT_TARGET;
  const context = clamp01(spec.contextWindow / contextTarget);

  const capability =
    (spec.caps.tools ? 0.5 : 0) +
    (spec.caps.vision ? 0.25 : 0) +
    (spec.caps.reasoning ? 0.25 : 0);

  const quota = quotaComponent(state, stats?.lastErrorKind ?? input.lastErrorKind ?? null);

  const breakdown: ScoreBreakdown = { uptime, quota, latency, context, capability };
  const totalWeight =
    weights.uptime + weights.quota + weights.latency + weights.context + weights.capability;
  const score =
    totalWeight <= 0
      ? 0
      : (breakdown.uptime * weights.uptime +
          breakdown.quota * weights.quota +
          breakdown.latency * weights.latency +
          breakdown.context * weights.context +
          breakdown.capability * weights.capability) /
        totalWeight;

  return { spec, score: routable ? score : 0, breakdown, routable };
}

/**
 * Rank models: routable first, then score (desc), then id (asc) so ordering
 * is deterministic when scores tie.
 */
export function rankModels(
  inputs: readonly RankInput[],
  weights: RankWeights,
  options: RankOptions = {},
): ModelScore[] {
  return inputs
    .map((input) => scoreModel(input, weights, options))
    .sort((a, b) => {
      if (a.routable !== b.routable) return a.routable ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.spec.id.localeCompare(b.spec.id);
    });
}

/**
 * Order candidate specs for alias resolution/failover. Models whose breaker
 * is `cooling`/`down` are pushed to the end (the gateway filters them
 * separately, so this is just a stable ordering).
 */
export function rankCandidateSpecs(
  candidates: readonly ModelSpec[],
  lookup: (spec: ModelSpec) => RankInput,
  weights: RankWeights,
  options: RankOptions = {},
): ModelSpec[] {
  return rankModels(candidates.map(lookup), weights, options).map((entry) => entry.spec);
}

function quotaComponent(state: CircuitState, lastErrorKind: ErrorKind | Outcome | null): number {
  if (state === "cooling" || state === "down") return 0;
  let quota = 1;
  if (lastErrorKind === "auth") quota = 0;
  else if (lastErrorKind === "capacity" || lastErrorKind === "rate_limited") quota = 0.4;
  else if (lastErrorKind !== null && lastErrorKind !== "ok" && lastErrorKind !== "drop") {
    // "drop" is a client disconnect and "ok" a success: both are neutral.
    quota = 0.7;
  }
  if (state === "degraded") quota = Math.min(quota, 0.6);
  return quota;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
