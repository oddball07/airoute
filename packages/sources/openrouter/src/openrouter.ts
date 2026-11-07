/**
 * OpenRouter source plugin for AIRoute.
 *
 * Unlike the zai wrapper, OpenRouter's model catalog is DYNAMIC: the default
 * path fetches `GET ${baseUrl}/models` live (see `catalog.ts`) and keeps only
 * the free models. Streaming, probing, and non-streaming completion are fully
 * delegated to the shared OpenAI-compatible kit (`@airoute/openai-compat`):
 * the kit's chat machinery only requires `model.sourceId === id` and accepts
 * an empty static `models` list, so the dynamic catalog needs no kit change.
 *
 * Config entry (`sources.registry`, all options optional):
 *
 *     { "type": "openrouter", "enabled": true, "baseUrl": "…",
 *       "models": […], "maxModels": 500, "allow": […], "disallow": […],
 *       "catalogTimeoutMs": 10000, "title": "AIRoute", "referer": "" }
 *
 * - When `models` is set it REPLACES catalog fetching entirely (offline use,
 *   tests) and is mapped through the kit's static-models path.
 * - Otherwise the live catalog is used: free filter → alphabetical sort →
 *   `allow` → `disallow` → `maxModels` cap (default 500; 0 = uncapped).
 *
 * The source self-skips without a key: `buildRegistry` checks
 * `OPENROUTER_API_KEY` (via `SOURCE_ENV_KEYS`) before this factory is ever
 * called and logs `source 'openrouter' disabled: no key (OPENROUTER_API_KEY is
 * not set)`. Malformed options throw `ConfigError` with a readable message
 * naming the offending option (surfaced as a skipped-source warning).
 *
 * API keys are read from the environment only — never from config, never
 * logged, never baked into a spec.
 */
import process from "node:process";
import {
  ConfigError,
  createLogger,
  type Logger,
  type ModelSpec,
  type Source,
  type SourceConfigEntry,
  type SourceFactory,
} from "@airoute/core";
import {
  createOpenAICompatSource,
  validateBaseUrl,
  validateSourceModelDefs,
  validateTimeoutMs,
  type OpenAICompatOptions,
  type OpenAICompatSource,
  type SourceModelDef,
} from "@airoute/openai-compat";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS,
  DEFAULT_OPENROUTER_MAX_MODELS,
  DEFAULT_OPENROUTER_TITLE,
  loadCatalogModels,
  openRouterAttributionHeaders,
  validateAttributionString,
  validateCatalogTimeoutMs,
  validateMaxModels,
  validatePatternList,
} from "./catalog.js";

export * from "./catalog.js";

/** Source id used by default (matches `SOURCE_ENV_KEYS.openrouter`). */
export const DEFAULT_OPENROUTER_SOURCE_ID = "openrouter";
/** Environment variable carrying the OpenRouter API key. */
export const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";

export interface OpenRouterSourceOptions {
  /** Source id; default `DEFAULT_OPENROUTER_SOURCE_ID` ("openrouter"). */
  id?: string;
  /** Default `DEFAULT_OPENROUTER_BASE_URL`. */
  baseUrl?: string;
  /** Default `process.env.OPENROUTER_API_KEY`. */
  apiKey?: string;
  /**
   * Static model override. When set, it replaces catalog fetching entirely
   * (offline use, tests) and is mapped through the kit's static-models path.
   */
  models?: SourceModelDef[];
  /**
   * Cap on the catalog after the free filter (taken in alphabetical order).
   * Default 500; 0 = uncapped. Ignored when `models` overrides the catalog.
   */
  maxModels?: number;
  /** Keep-side patterns (id substrings / regex sources); unset keeps all. */
  allow?: string[];
  /** Drop-side patterns; applied after `allow`. */
  disallow?: string[];
  /** Catalog GET timeout; default {@link DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS}. */
  catalogTimeoutMs?: number;
  /** `X-Title` attribution; default `"AIRoute"`; "" disables the header. */
  title?: string;
  /** `HTTP-Referer` attribution; default "" → header omitted. */
  referer?: string;
  /** Chat idle timeout; forwarded to the kit (default kit 60 s). */
  timeoutMs?: number;
  /** Logger for catalog warn-skips; never logs keys. */
  logger?: Logger;
  /** Injectable fetch — the offline-test seam (catalog AND kit chat calls). */
  fetch?: typeof fetch;
}

/**
 * Direct constructor for tests and bespoke wiring. Applies OpenRouter
 * defaults and hands the chat machinery to the shared kit (which validates
 * everything, throwing `ConfigError` on malformed options); the catalog is
 * fetched live unless `models` overrides it.
 */
export function createOpenRouterSource(options: OpenRouterSourceOptions = {}): OpenAICompatSource {
  const logger = options.logger ?? createLogger({ scope: "airoute:openrouter" });
  // The kit validates `id`/`baseUrl` etc.; only the defaults are resolved here.
  const id = options.id !== undefined ? options.id : DEFAULT_OPENROUTER_SOURCE_ID;
  const baseUrl =
    options.baseUrl !== undefined
      ? validateBaseUrl(options.baseUrl, `openrouter source "${id}"`)
      : DEFAULT_OPENROUTER_BASE_URL;
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env[OPENROUTER_ENV_KEY];
  const title = options.title !== undefined ? options.title : DEFAULT_OPENROUTER_TITLE;
  const referer = options.referer !== undefined ? options.referer : "";
  const staticModels =
    options.models !== undefined
      ? validateSourceModelDefs(options.models, `openrouter source "${id}"`)
      : undefined;
  const catalogTimeoutMs =
    options.catalogTimeoutMs !== undefined
      ? validateCatalogTimeoutMs(options.catalogTimeoutMs, `openrouter source "${id}"`)
      : DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS;
  const maxModels =
    options.maxModels !== undefined
      ? validateMaxModels(options.maxModels, `openrouter source "${id}"`)
      : DEFAULT_OPENROUTER_MAX_MODELS;
  const attribution = openRouterAttributionHeaders(title, referer);

  // The kit does NOT gate streaming on static-list membership (it only needs
  // `model.sourceId === id`), and `models: []` is explicitly valid — so the
  // dynamic catalog path needs no kit change: the kit advertises nothing and
  // this source supplies `listModels()` from the live catalog.
  const kitOptions: OpenAICompatOptions = {
    id,
    baseUrl,
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
    headers: attribution, // X-Title (+ HTTP-Referer) on every chat call
    models: staticModels ?? [],
  };
  if (options.timeoutMs !== undefined) kitOptions.timeoutMs = options.timeoutMs;
  if (options.fetch !== undefined) kitOptions.fetch = options.fetch;
  const kit = createOpenAICompatSource(kitOptions);

  async function listModels(): Promise<ModelSpec[]> {
    if (staticModels !== undefined) return kit.listModels();
    return loadCatalogModels({
      sourceId: id,
      baseUrl,
      apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
      title,
      referer,
      catalogTimeoutMs,
      allow: options.allow,
      disallow: options.disallow,
      maxModels,
      logger,
      fetch: options.fetch,
    });
  }

  return {
    id,
    listModels,
    stream: (args) => kit.stream(args),
    probe: (model) => kit.probe(model),
    complete: (model, request) => kit.complete(model, request),
  };
}

/**
 * `SourceFactory` for the `"openrouter"` source type. Reads extra entry
 * options defensively — anything malformed raises `ConfigError` with a
 * readable message naming the offending option (which `buildRegistry` turns
 * into a skipped-source warning instead of a crash).
 */
export const createOpenRouterSourceFactory: SourceFactory = (entry: SourceConfigEntry): Source => {
  if (typeof entry !== "object" || entry === null) {
    throw new ConfigError(`source '${DEFAULT_OPENROUTER_SOURCE_ID}': config entry must be an object`);
  }
  const context = `source '${DEFAULT_OPENROUTER_SOURCE_ID}' option`;
  const options: OpenRouterSourceOptions = { apiKey: process.env[OPENROUTER_ENV_KEY] };

  const baseUrl = entry["baseUrl"];
  if (baseUrl !== undefined) options.baseUrl = validateBaseUrl(baseUrl, context);

  const models = entry["models"];
  if (models !== undefined) options.models = validateSourceModelDefs(models, context);

  const maxModels = entry["maxModels"];
  if (maxModels !== undefined) options.maxModels = validateMaxModels(maxModels, context);

  const allow = entry["allow"];
  if (allow !== undefined) options.allow = validatePatternList(allow, context, "allow");

  const disallow = entry["disallow"];
  if (disallow !== undefined) options.disallow = validatePatternList(disallow, context, "disallow");

  const catalogTimeoutMs = entry["catalogTimeoutMs"];
  if (catalogTimeoutMs !== undefined) options.catalogTimeoutMs = validateCatalogTimeoutMs(catalogTimeoutMs, context);

  const title = entry["title"];
  if (title !== undefined) options.title = validateAttributionString(title, context, "title");

  const referer = entry["referer"];
  if (referer !== undefined) options.referer = validateAttributionString(referer, context, "referer");

  const timeoutMs = entry["timeoutMs"];
  if (timeoutMs !== undefined) options.timeoutMs = validateTimeoutMs(timeoutMs, context);

  return createOpenRouterSource(options);
};

/* `Source` and `ModeSpec`-related re-exports for the public surface. */
export type { Source, SourceConfigEntry, SourceFactory, SourceModelDef };
