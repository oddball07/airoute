import type { ModelSpec } from "./types.js";
import type { SourceRegistry } from "./registry.js";

/**
 * Gateway-level aliases declared in config, e.g.
 * `{ "free-best": ["zai/glm-4.5-air", "openrouter/meta:llama-3.3-70b"] }`.
 * Candidates are tried in order; ranking arrives in Phase 2.
 */
export interface AliasMap {
  readonly [alias: string]: readonly string[];
}

export type ResolveResult =
  | { kind: "exact"; spec: ModelSpec }
  | { kind: "alias"; spec: ModelSpec }
  | { kind: "unknown" };

/**
 * Full candidate resolution (Phase 2): the ordered list the gateway tries.
 *
 * - `exact`   — single id match.
 * - `alias`   — every present candidate of the bucket (or every spec that
 *   declared the alias), ordered by `rankCandidates` when supplied.
 * - `unknown` — empty list; callers respond 404.
 */
export type CandidateResolution =
  | { kind: "exact" | "alias"; candidates: ModelSpec[] }
  | { kind: "unknown"; candidates: [] };

export interface ResolveOptions {
  /** Config-declared alias buckets. When omitted, only source-declared aliases apply. */
  aliasMap?: AliasMap;
  /**
   * Reorder alias candidates (e.g. by live health score). Exact matches are
   * never reordered. The callback receives a copy it may freely sort, plus
   * the alias name so preference profiles (`free-fast`, `free-coder`) can
   * adjust their weights.
   */
  rankCandidates?: (candidates: readonly ModelSpec[], alias: string) => readonly ModelSpec[];
}

/**
 * Resolve a gateway-level model name to its ordered candidate list against an
 * already-fetched list of specs (as returned by `SourceRegistry.models()`).
 */
export function resolveCandidates(
  specs: readonly ModelSpec[],
  name: string,
  options: ResolveOptions = {},
): CandidateResolution {
  const requested = name.trim();
  if (requested.length === 0) return { kind: "unknown", candidates: [] };

  const exact = specs.find((spec) => spec.id === requested);
  if (exact) return { kind: "exact", candidates: [exact] };

  const bucket = options.aliasMap?.[requested];
  let candidates: ModelSpec[] = [];
  if (bucket !== undefined) {
    const seen = new Set<string>();
    for (const candidateId of bucket) {
      const candidate = specs.find((spec) => spec.id === candidateId);
      if (candidate !== undefined && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        candidates.push(candidate);
      }
    }
  }
  if (candidates.length === 0) {
    candidates = specs.filter((spec) => spec.aliases.includes(requested));
  }
  // A declared-but-empty bucket (the shipped defaults for free-best /
  // free-coder / free-fast) falls back to the whole catalog, so those aliases
  // work out of the box; ranking then picks the best candidate.
  if (
    candidates.length === 0 &&
    bucket !== undefined &&
    options.rankCandidates !== undefined
  ) {
    candidates = [...specs];
  }
  if (candidates.length === 0) return { kind: "unknown", candidates: [] };

  if (candidates.length > 1 && options.rankCandidates !== undefined) {
    candidates = [...options.rankCandidates([...candidates], requested)];
  }
  return { kind: "alias", candidates };
}

/**
 * Resolve a gateway-level model name to a concrete `ModelSpec` against an
 * already-fetched list of specs (as returned by `SourceRegistry.models()`).
 *
 * 1. `kind: "exact"` — the name matches a `ModelSpec.id`.
 * 2. `kind: "alias"` — the name resolves through a config alias bucket
 *    (highest-ranked *present* candidate wins, i.e. all candidates come from
 *    enabled sources since the registry only knows enabled models) or through
 *    an alias a source declared on its own `ModelSpec.aliases`.
 * 3. `kind: "unknown"` — callers must respond 404.
 *
 * This is the single-pick convenience over {@link resolveCandidates}.
 */
export function resolveModelFromSpecs(
  specs: readonly ModelSpec[],
  name: string,
  options: ResolveOptions = {},
): ResolveResult {
  const resolution = resolveCandidates(specs, name, options);
  if (resolution.kind === "unknown" || resolution.candidates.length === 0) {
    return { kind: "unknown" };
  }
  const first = resolution.candidates[0] as ModelSpec;
  return resolution.kind === "exact"
    ? { kind: "exact", spec: first }
    : { kind: "alias", spec: first };
}

/** How an alias obtained its candidate list. */
export type AliasMode = "explicit" | "auto" | "shadowed";

/** Human/tooling-facing description of one configured alias. */
export interface AliasDescription {
  alias: string;
  /**
   * `explicit` — the config bucket listed at least one model that exists.
   * `auto`     — empty bucket (or none of its ids exist) resolved to the catalog.
   * `shadowed` — a model id has the same name, so the exact match wins.
   */
  mode: AliasMode;
  /** True when a non-empty config bucket resolved to nothing and fell back to the catalog. */
  fallback: boolean;
  /** Free candidate ids in routing order (ranker applied). Empty = unusable alias. */
  candidates: string[];
}

/**
 * Describe every configured alias for `GET /v1/models`, `airoute models` and
 * `airoute status`. Pure: callers supply the catalog and, optionally, the same
 * ranker routing uses so the listed order matches the failover order.
 *
 * Paid candidates are dropped: an alias never advertises a model the gateway
 * would refuse with 403.
 */
export function describeAliases(
  specs: readonly ModelSpec[],
  aliasMap: AliasMap,
  options: { rankCandidates?: ResolveOptions["rankCandidates"] } = {},
): AliasDescription[] {
  const descriptions: AliasDescription[] = [];
  for (const alias of Object.keys(aliasMap)) {
    const bucket = aliasMap[alias] ?? [];
    if (specs.some((spec) => spec.id === alias)) {
      descriptions.push({ alias, mode: "shadowed", fallback: false, candidates: [alias] });
      continue;
    }
    const resolution = resolveCandidates(specs, alias, {
      aliasMap,
      // An empty bucket means "rank the catalog"; without a ranker the router
      // has nothing to order, so use a neutral one to keep the description
      // truthful for callers that only inspect the catalog (`airoute models`).
      rankCandidates: options.rankCandidates ?? ((candidates) => candidates),
    });
    const candidates = resolution.candidates
      .filter((spec) => spec.free === true)
      .map((spec) => spec.id);
    const explicitPresent = bucket.some((id) => specs.some((spec) => spec.id === id));
    descriptions.push({
      alias,
      mode: explicitPresent ? "explicit" : "auto",
      fallback: !explicitPresent && bucket.length > 0,
      candidates,
    });
  }
  return descriptions;
}

/**
 * Model name resolution against the registry. Fetches the (cached) aggregated
 * catalog, then applies `resolveModelFromSpecs`.
 */
export async function resolveModel(
  registry: SourceRegistry,
  name: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  return resolveModelFromSpecs(await registry.models(), name, options);
}

/**
 * Rank known model ids by similarity to a requested (but unknown) name, for
 * "did you mean" hints in 404 responses.
 */
export function closestModelIds(requested: string, modelIds: readonly string[], limit = 5): string[] {
  const needle = requested.toLowerCase();
  const segments = needle.split("/").filter((part) => part.length > 0);
  const scored = modelIds.map((id) => {
    const lower = id.toLowerCase();
    let score = 0;
    if (lower === needle) score = 10;
    else if (lower.startsWith(needle)) score = 6;
    else if (lower.includes(needle)) score = 4;
    else if (segments.some((segment) => lower.includes(segment))) score = 1;
    return { id, score };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((entry) => entry.id);
}
