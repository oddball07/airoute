import type { ModelSpec, Source } from "./types.js";
import { createLogger, type Logger } from "./log.js";

/**
 * Holds the registered sources and aggregates their model lists.
 *
 * `models()` fans out to every source in parallel; a source that fails is
 * skipped with a single warn log instead of failing the whole call.
 */
export class SourceRegistry {
  readonly #sources: Map<string, Source>;
  readonly #order: string[];
  readonly #logger: Logger;

  constructor(logger: Logger = createLogger({ scope: "airoute:registry" })) {
    this.#sources = new Map();
    this.#order = [];
    this.#logger = logger;
  }

  /** Register a source. Re-registering an id replaces the previous one (logged as warn). */
  register(source: Source): this {
    if (this.#sources.has(source.id)) {
      this.#logger.warn(`source '${source.id}' re-registered; replacing the previous instance`);
    } else {
      this.#order.push(source.id);
    }
    this.#sources.set(source.id, source);
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
   * skipped with exactly one warn log; the others are still returned.
   */
  async models(): Promise<ModelSpec[]> {
    const sources = this.all();
    const settled = await Promise.allSettled(sources.map((source) => source.listModels()));
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
}

/** Convenience factory for a `SourceRegistry`. */
export function createSourceRegistry(logger?: Logger): SourceRegistry {
  return new SourceRegistry(logger);
}
