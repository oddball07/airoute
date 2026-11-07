import type { ModelSpec, Source } from "./types.js";
import { createLogger, type Logger } from "./log.js";

/** Default freshness window for cached per-source model catalogs. */
export const DEFAULT_CATALOG_TTL_MS = 60_000;

/** One cached per-source model list. */
export interface CatalogCacheEntry<V> {
  value: V;
  /** Clock time (ms epoch) at which the value was fetched. */
  fetchedAtMs: number;
}

/**
 * The get/put seam for the registry's per-source model catalog cache.
 *
 * `get` returns the entry when one exists at all — fresh *or* stale — so
 * callers can serve a stale value when a refresh fails; freshness is
 * `Date.now() - fetchedAtMs < ttlMs`.
 */
export interface CatalogCache {
  /** Freshness window in ms; `0` means caching is disabled entirely. */
  readonly ttlMs: number;
  get(key: string): CatalogCacheEntry<ModelSpec[]> | undefined;
  put(key: string, models: ModelSpec[]): void;
}

/** Default `CatalogCache`: entries keyed by source id, expiring after `ttlMs`. */
export class TtlCatalogCache implements CatalogCache {
  readonly ttlMs: number;
  readonly #entries = new Map<string, CatalogCacheEntry<ModelSpec[]>>();

  constructor(ttlMs: number = DEFAULT_CATALOG_TTL_MS) {
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError(`cacheTtlMs must be a finite non-negative number, got ${String(ttlMs)}`);
    }
    this.ttlMs = ttlMs;
  }

  get(key: string): CatalogCacheEntry<ModelSpec[]> | undefined {
    return this.#entries.get(key);
  }

  put(key: string, models: ModelSpec[]): void {
    this.#entries.set(key, { value: models, fetchedAtMs: Date.now() });
  }
}

export interface SourceRegistryOptions {
  /**
   * Freshness window for the per-source model catalog cache, in ms.
   * `0` disables caching. Default 60 000.
   */
  cacheTtlMs?: number;
  /** Injected cache implementation; overrides `cacheTtlMs` when given. */
  cache?: CatalogCache;
}

/**
 * Holds the registered sources and aggregates their model lists.
 *
 * `models()` fans out to every source in parallel; a source that fails is
 * skipped with a single warn log instead of failing the whole call.
 *
 * Per-source `listModels()` results are cached for `cacheTtlMs` (default
 * 60 s) so repeated gateway requests do not refetch provider catalogs. A
 * concurrent refresh is shared (single in-flight fetch per source); when a
 * refresh fails but a cached value exists (fresh or stale), the stale value
 * is served with a warn instead of skipping the source.
 */
export class SourceRegistry {
  readonly #sources: Map<string, Source>;
  readonly #order: string[];
  readonly #logger: Logger;
  readonly #cache: CatalogCache;
  readonly #inflight = new Map<string, Promise<ModelSpec[]>>();

  constructor(
    logger: Logger = createLogger({ scope: "airoute:registry" }),
    options: SourceRegistryOptions = {},
  ) {
    this.#sources = new Map();
    this.#order = [];
    this.#logger = logger;
    this.#cache = options.cache ?? new TtlCatalogCache(options.cacheTtlMs ?? DEFAULT_CATALOG_TTL_MS);
  }

  /** Register a source. Re-registering an id replaces the previous one (logged as warn). */
  register(source: Source): this {
    if (this.#sources.has(source.id)) {
      this.#logger.warn(`source '${source.id}' re-registered; replacing the previous instance`);
    } else {
      this.#order.push(source.id);
    }
    this.#sources.set(source.id, source);
    // The replacement may advertise a different catalog; drop any stale fetch.
    this.#inflight.delete(source.id);
    return this;
  }

  registerAll(sources: readonly Source[]): this {
    for (const source of sources) this.register(source);
    return this;
  }

  /** All sources in registration order. */
  all(): Source[] {
    return this.#order.map((id) => this.#sources.get(id) as Source);
  }

  get(id: string): Source | undefined {
    return this.#sources.get(id);
  }

  has(id: string): boolean {
    return this.#sources.has(id);
  }

  /**
   * Aggregate `listModels()` across sources, in parallel. A failing source is
   * skipped with exactly one warn log; the others are still returned. Results
   * come from the per-source cache when fresh.
   */
  async models(): Promise<ModelSpec[]> {
    const sources = this.all();
    const settled = await Promise.allSettled(sources.map((source) => this.#modelList(source)));
    const out: ModelSpec[] = [];
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i] as Source;
      const result = settled[i] as PromiseSettledResult<ModelSpec[]>;
      if (result.status === "fulfilled") {
        out.push(...result.value);
      } else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.#logger.warn(`source '${source.id}' failed to list models; skipping it`, {
          error: reason,
        });
      }
    }
    return out;
  }

  /**
   * One source's model list through the TTL catalog cache: fresh value →
   * cached promise → refresh. `ttlMs` 0 bypasses caching entirely (a failing
   * fetch then propagates and `models()` skips the source as before).
   */
  #modelList(source: Source): Promise<ModelSpec[]> {
    if (this.#cache.ttlMs <= 0) return source.listModels();

    const fresh = this.#freshEntry(source.id);
    if (fresh !== undefined) return Promise.resolve(fresh.value);

    const pending = this.#inflight.get(source.id);
    if (pending !== undefined) return pending;

    const refresh = this.#refresh(source);
    this.#inflight.set(source.id, refresh);
    void refresh.finally(() => {
      if (this.#inflight.get(source.id) === refresh) this.#inflight.delete(source.id);
    }).catch(() => undefined); // rejections are consumed by models()' allSettled
    return refresh;
  }

  /** Fetch through to the source; on failure serve a cached value (warn) or propagate. */
  async #refresh(source: Source): Promise<ModelSpec[]> {
    try {
      const models = await source.listModels();
      this.#cache.put(source.id, models);
      return models;
    } catch (err) {
      const cached = this.#cache.get(source.id);
      if (cached === undefined) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.#logger.warn(
        `source '${source.id}' failed to refresh models; serving the stale cached catalog`,
        { error: reason },
      );
      return cached.value;
    }
  }

  #freshEntry(sourceId: string): CatalogCacheEntry<ModelSpec[]> | undefined {
    const entry = this.#cache.get(sourceId);
    if (entry === undefined) return undefined;
    return Date.now() - entry.fetchedAtMs < this.#cache.ttlMs ? entry : undefined;
  }
}

/** Convenience factory for a `SourceRegistry`. */
export function createSourceRegistry(
  logger?: Logger,
  options?: SourceRegistryOptions,
): SourceRegistry {
  return new SourceRegistry(logger, options);
}
