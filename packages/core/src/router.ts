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

export interface ResolveOptions {
  /** Config-declared alias buckets. When omitted, only source-declared aliases apply. */
  aliasMap?: AliasMap;
}

/**
 * Resolve a gateway-level model name to a concrete `ModelSpec`.
 *
 * 1. `kind: "exact"` — the name matches a `ModelSpec.id`.
 * 2. `kind: "alias"` — the name resolves through a config alias bucket
 *    (first *present* candidate wins, i.e. all candidates come from enabled
 *    sources since the registry only knows enabled models) or through an
 *    alias a source declared on its own `ModelSpec.aliases`. Ranking across
 *    multiple live candidates arrives in Phase 2.
 * 3. `kind: "unknown"` — callers must respond 404.
 */
export async function resolveModel(
  registry: SourceRegistry,
  name: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const requested = name.trim();
  const specs = await registry.models();
  if (requested.length > 0) {
    const exact = specs.find((spec) => spec.id === requested);
    if (exact) return { kind: "exact", spec: exact };

    const bucket = options.aliasMap?.[requested];
    if (bucket !== undefined) {
      for (const candidateId of bucket) {
        const candidate = specs.find((spec) => spec.id === candidateId);
        if (candidate) return { kind: "alias", spec: candidate };
      }
    }

    const declared = specs.find((spec) => spec.aliases.includes(requested));
    if (declared) return { kind: "alias", spec: declared };
  }
  return { kind: "unknown" };
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
