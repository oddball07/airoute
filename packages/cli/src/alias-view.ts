/**
 * Alias presentation helpers (Phase 4).
 *
 * One source of truth for how aliases are described to humans (`airoute
 * models`, `airoute status`) and to tooling (`--json`). The candidate order is
 * whatever the router would try, so the display never disagrees with routing.
 */
import { describeAliases, type AliasMode, type ModelSpec } from "@airoute/core";
import type { CircuitState } from "@airoute/monitor";

/** Subset of `HealthTracker` this module needs (keeps it easy to test). */
export interface AliasHealth {
  state(sourceId: string, modelId: string): CircuitState;
  cooldownExpiresAt(sourceId: string, modelId: string): number;
}

export interface AliasCandidateView {
  id: string;
  /** Present only when health was supplied. */
  state?: CircuitState;
  /** Milliseconds until the candidate is routable again, when it is cooling/down. */
  retryInMs?: number;
}

export interface AliasView {
  alias: string;
  mode: AliasMode;
  fallback: boolean;
  /** Free candidates in routing order; `[0]` is the preferred pick. */
  candidates: AliasCandidateView[];
  /** First routable candidate (healthy/degraded), or null when none is usable. */
  best: string | null;
  counts?: { healthy: number; degraded: number; cooling: number; down: number };
}

/**
 * Build the alias views used by `models --json` / `status --json` and the
 * human sections. `ranker` should be the gateway's ranker (health-aware) so the
 * order matches failover; `health` is optional (`models` runs without a store).
 */
export function buildAliasViews(
  specs: readonly ModelSpec[],
  aliasMap: Readonly<Record<string, readonly string[]>>,
  ranker?: (candidates: readonly ModelSpec[], alias: string) => readonly ModelSpec[],
  health?: AliasHealth,
): AliasView[] {
  const byId = new Map(specs.map((spec) => [spec.id, spec] as const));
  const descriptions = describeAliases(specs, aliasMap, ranker !== undefined ? { rankCandidates: ranker } : {});
  return descriptions.map((description) => {
    const counts = { healthy: 0, degraded: 0, cooling: 0, down: 0 };
    const candidates: AliasCandidateView[] = [];
    let best: string | null = null;
    for (const id of description.candidates) {
      const spec = byId.get(id);
      if (spec === undefined) continue;
      const candidate: AliasCandidateView = { id };
      if (health !== undefined) {
        const state = health.state(spec.sourceId, spec.id);
        candidate.state = state;
        counts[state] += 1;
        const retryAt = health.cooldownExpiresAt(spec.sourceId, spec.id);
        const retryIn = retryAt - Date.now();
        if (retryIn > 0) candidate.retryInMs = retryIn;
        if (best === null && (state === "healthy" || state === "degraded")) best = id;
      } else if (best === null) {
        best = id;
      }
      candidates.push(candidate);
    }
    return {
      alias: description.alias,
      mode: description.mode,
      fallback: description.fallback,
      candidates,
      best,
      // Health counts only make sense when a health layer was supplied.
      ...(health !== undefined ? { counts } : {}),
    };
  });
}

/** Short mode label, e.g. `auto (fallback)` when a bucket's ids are all missing. */
export function aliasModeLabel(view: Pick<AliasView, "mode" | "fallback">): string {
  if (view.mode === "auto" && view.fallback) return "auto (fallback)";
  return view.mode;
}

/** One-line candidate summary: `3 ready, 1 cooling (4m 58s)` or `5 candidates`. */
export function aliasSummary(view: AliasView, withHealth: boolean): string {
  if (view.candidates.length === 0) {
    return withHealth ? "no routable candidate" : "no candidates";
  }
  if (!withHealth || view.counts === undefined) {
    return `${view.candidates.length} candidate${view.candidates.length === 1 ? "" : "s"}`;
  }
  const parts: string[] = [];
  const counts = view.counts;
  if (counts.healthy > 0) parts.push(`${counts.healthy} ready`);
  if (counts.degraded > 0) parts.push(`${counts.degraded} degraded`);
  if (counts.cooling > 0) parts.push(`${counts.cooling} cooling`);
  if (counts.down > 0) parts.push(`${counts.down} down`);
  return parts.join(", ");
}

/** Longest wait among blocked candidates, e.g. `retry in ~5m`. */
export function aliasRetryHint(view: AliasView): string | null {
  const waits = view.candidates
    .map((candidate) => candidate.retryInMs ?? 0)
    .filter((ms) => ms > 0);
  if (waits.length === 0) return null;
  const longest = Math.max(...waits);
  return `retry in ~${formatDuration(longest)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

/**
 * Render the alias block appended to `airoute models` / `airoute status`.
 * Returns lines without a trailing newline.
 */
export function formatAliasSection(views: readonly AliasView[], withHealth: boolean): string[] {
  if (views.length === 0) {
    return ["aliases:", "  (none configured — add \"aliases\" to the airoute config)"];
  }
  const aliasWidth = Math.max("ALIAS".length, ...views.map((view) => view.alias.length)) + 2;
  const modeWidth = Math.max("MODE".length, ...views.map((view) => aliasModeLabel(view).length)) + 2;
  const bestLabels = views.map((view) => {
    if (view.best !== null) return view.best;
    return withHealth ? "(none available)" : "(no candidate)";
  });
  const bestWidth = Math.max("BEST".length, ...bestLabels.map((label) => label.length)) + 2;
  const header = `${pad("ALIAS", aliasWidth)}${pad("MODE", modeWidth)}${pad("BEST", bestWidth)}CANDIDATES`;
  const lines = ["aliases:", `  ${header}`, `  ${"-".repeat(header.length)}`];
  views.forEach((view, index) => {
    const summary = aliasSummary(view, withHealth);
    const retry = withHealth ? aliasRetryHint(view) : null;
    const suffix = retry !== null && view.best === null ? ` (${retry})` : "";
    lines.push(
      `  ${pad(view.alias, aliasWidth)}${pad(aliasModeLabel(view), modeWidth)}${pad(bestLabels[index] as string, bestWidth)}${summary}${suffix}`,
    );
  });
  return lines;
}
