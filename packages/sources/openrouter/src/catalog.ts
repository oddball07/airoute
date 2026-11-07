/**
 * OpenRouter live model-catalog handling for the AIRoute openrouter source.
 *
 * `GET ${baseUrl}/models` is a PUBLIC OpenRouter endpoint (no auth required,
 * though the optional attribution headers and `Authorization` are sent when
 * set). It returns:
 *
 *     { "data": [ { id, name, context_length?, pricing: { prompt, completion },
 *                   architecture?: { input_modalities?: string[] },
 *                   supported_parameters?: string[],
 *                   top_provider?: { context_length?, max_completion_tokens? } } ] }
 *
 * Phase 1 is FREE-ONLY: an entry is kept iff its id ends with ":free" OR both
 * `pricing.prompt` and `pricing.completion` are exactly "0". Paid entries are
 * dropped silently (they are the expected case on OpenRouter); entries with an
 * unknown shape or no usable id are skipped with a warn. A single weird entry
 * never throws the whole catalog.
 *
 * Catalog fetch failures throw `UpstreamError` — `network_error` for
 * fetch-level failures and timeouts, `http_<status>` for non-2xx responses,
 * `upstream_error` for an unparseable 2xx body — so the registry's
 * aggregation skips the source with a warn instead of failing startup.
 *
 * Everything is offline-testable via an injected `fetch` (never hit the real
 * network in tests) and never logs the API key — log ids and counts only.
 */
import { ConfigError, UpstreamError, type Logger, type ModelSpec } from "@airoute/core";
import { SseTimeoutError, awaitWithTimeout } from "@airoute/openai-compat";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Default OpenRouter base URL; `/models` and `/chat/completions` live below it. */
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Whole-request timeout for the catalog GET. */
export const DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS = 10_000;
/** Default cap on the (filtered, alphabetically sorted) catalog size. */
export const DEFAULT_OPENROUTER_MAX_MODELS = 500;
/** Default `X-Title` attribution sent with catalog and chat calls. */
export const DEFAULT_OPENROUTER_TITLE = "AIRoute";

/* -------------------------------------------------------------------------- */
/* Option validation helpers (shared with the source factory)                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an `allow`/`disallow` option: array of id-pattern strings. */
export function validatePatternList(value: unknown, context: string, option: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${context}: "${option}" must be an array of strings`);
  }
  return value as string[];
}

/** Validate a `maxModels` option: non-negative integer; 0 = uncapped. */
export function validateMaxModels(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${context}: "maxModels" must be a non-negative integer (0 = no cap)`);
  }
  return value;
}

/** Validate a `title`/`referer` option: any string ("" = omit the header). */
export function validateAttributionString(value: unknown, context: string, option: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${context}: "${option}" must be a string`);
  }
  return value;
}

/** Validate a `catalogTimeoutMs` option (named for its own option, unlike the kit's generic `validateTimeoutMs`). */
export function validateCatalogTimeoutMs(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${context}: "catalogTimeoutMs" must be a positive number of milliseconds`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Attribution headers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * OpenRouter app-attribution headers: `X-Title` (an app label) and
 * `HTTP-Referer` (the associated site) feed OpenRouter's app rankings. Empty
 * values omit the respective header.
 */
export function openRouterAttributionHeaders(title: string, referer: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (title.length > 0) headers["X-Title"] = title;
  if (referer.length > 0) headers["HTTP-Referer"] = referer;
  return headers;
}

/* -------------------------------------------------------------------------- */
/* Free filter + entry mapping                                                */
/* -------------------------------------------------------------------------- */

function isZeroPrice(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "0";
  if (typeof value === "number") return value === 0;
  return false;
}

/**
 * The free rule: an id ending in ":free", or both prices exactly "0".
 * Absent pricing with a non-":free" id means NOT free (paid until proven free).
 */
export function isFreeCatalogEntry(modelId: string, pricing: Record<string, unknown>): boolean {
  return (
    modelId.endsWith(":free") ||
    (isZeroPrice(pricing["prompt"]) && isZeroPrice(pricing["completion"]))
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** First candidate that is a positive number (tokens); 0 when none is. */
function firstContextWindow(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }
  return 0;
}

/**
 * Map one catalog entry onto a `ModelSpec`. Returns `undefined` for entries
 * that are not objects, carry no usable id, or are NOT free — no throw, ever.
 * (The caller decides which of those to warn about.)
 */
export function mapCatalogEntry(entry: unknown, sourceId: string): ModelSpec | undefined {
  if (!isRecord(entry)) return undefined;
  const modelId = typeof entry["id"] === "string" ? entry["id"].trim() : "";
  if (modelId.length === 0) return undefined;
  const pricing = isRecord(entry["pricing"]) ? entry["pricing"] : {};
  if (!isFreeCatalogEntry(modelId, pricing)) return undefined;

  const name = typeof entry["name"] === "string" && entry["name"].trim().length > 0 ? entry["name"] : modelId;
  const architecture = isRecord(entry["architecture"]) ? entry["architecture"] : {};
  const topProvider = isRecord(entry["top_provider"]) ? entry["top_provider"] : {};
  const inputModalities = stringList(architecture["input_modalities"]);
  const supportedParameters = stringList(entry["supported_parameters"]);
  const contextWindow = firstContextWindow(entry["context_length"], topProvider["context_length"]);

  return {
    id: `${sourceId}/${modelId}`,
    sourceId,
    sourceModelId: modelId,
    label: name,
    contextWindow,
    caps: {
      tools: supportedParameters.includes("tools"),
      vision: inputModalities.includes("image"),
      // OpenRouter has shipped both parameter names across API versions —
      // tolerate both when deciding the reasoning capability.
      reasoning:
        supportedParameters.includes("reasoning") || supportedParameters.includes("include_reasoning"),
    },
    free: true,
    aliases: [],
    // Light + documented, mirroring the kit's meta shape: contextWindow
    // mirrors the spec field; raw shallow-copies the catalog entry.
    meta: { contextWindow, raw: { ...entry } },
  };
}

/* -------------------------------------------------------------------------- */
/* allow / disallow pattern matching + deterministic ordering                  */
/* -------------------------------------------------------------------------- */

/**
 * One pattern matches an id as a substring, or — when it parses — as a
 * regular-expression source (`"deepseek"` substring; `".*:free$"` regex).
 * An invalid regex falls back to the substring reading only.
 */
export function idMatchesPattern(id: string, pattern: string): boolean {
  if (id.includes(pattern)) return true;
  try {
    return new RegExp(pattern).test(id);
  } catch {
    return false;
  }
}

function specMatchesAnyPattern(spec: ModelSpec, patterns: readonly string[]): boolean {
  // Both the gateway id ("openrouter/<provider-id>") and the raw provider id
  // are matched, so either spelling works in config patterns.
  return patterns.some(
    (pattern) => idMatchesPattern(spec.sourceModelId, pattern) || idMatchesPattern(spec.id, pattern),
  );
}

export interface CatalogFilterOptions {
  /** Keep-side patterns; unset/empty keeps everything. */
  allow?: string[];
  /** Drop-side patterns; applied after `allow`. */
  disallow?: string[];
  /** Cap on the kept list (taken in sorted order); 0 or unset = uncapped. */
  maxModels?: number;
}

/** Sort alphabetically for determinism, then apply allow → disallow → maxModels. */
export function filterCatalogSpecs(specs: ModelSpec[], options: CatalogFilterOptions): ModelSpec[] {
  let out = [...specs].sort((a, b) => a.id.localeCompare(b.id));
  const { allow, disallow, maxModels } = options;
  if (allow !== undefined && allow.length > 0) {
    out = out.filter((spec) => specMatchesAnyPattern(spec, allow));
  }
  if (disallow !== undefined && disallow.length > 0) {
    out = out.filter((spec) => !specMatchesAnyPattern(spec, disallow));
  }
  if (maxModels !== undefined && maxModels > 0) out = out.slice(0, maxModels);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Catalog fetch                                                              */
/* -------------------------------------------------------------------------- */

export interface CatalogFetchOptions {
  /** Source id that prefixes every mapped model id. */
  sourceId: string;
  /** Base URL; the catalog lives at `${baseUrl}/models`. */
  baseUrl: string;
  /** When set, the GET carries `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** `X-Title` value ("" = omit the header). */
  title?: string;
  /** `HTTP-Referer` value ("" = omit the header). */
  referer?: string;
  /** Whole-request timeout; default {@link DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS}. */
  catalogTimeoutMs?: number;
  /** Injectable fetch — the offline-test seam. */
  fetch?: typeof fetch;
}

/** Headers for the catalog GET: accept, the bearer key when present, attribution. */
export function catalogHeaders(options: CatalogFetchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...openRouterAttributionHeaders(options.title ?? DEFAULT_OPENROUTER_TITLE, options.referer ?? ""),
  };
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers["authorization"] = `Bearer ${options.apiKey}`;
  }
  return headers;
}

export interface LoadCatalogOptions extends CatalogFetchOptions, CatalogFilterOptions {
  /** Warn-skips for malformed entries go here (never the API key). */
  logger: Logger;
}

/**
 * Fetch, filter, and map the live OpenRouter catalog (free-only). Throws
 * `UpstreamError` on fetch-level failure or timeout (`network_error`), on a
 * non-2xx response (`http_<status>`), and on an unparseable 2xx body
 * (`upstream_error`) — `SourceRegistry.models()` then warns and skips this
 * source. Malformed single entries never throw: they are warn-skipped.
 */
export async function loadCatalogModels(options: LoadCatalogOptions): Promise<ModelSpec[]> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl}/models`;
  const timeoutMs = options.catalogTimeoutMs ?? DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS;

  const abort = new AbortController();
  let res: Response;
  try {
    const pending = fetchFn(url, {
      method: "GET",
      headers: catalogHeaders(options),
      signal: abort.signal,
    });
    res = await awaitWithTimeout(pending, timeoutMs, (err) => abort.abort(err));
  } catch (err) {
    abort.abort();
    if (err instanceof SseTimeoutError) {
      throw new UpstreamError(`openrouter catalog request to ${url} timed out after ${timeoutMs}ms`, {
        status: 504,
        code: "network_error",
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`openrouter catalog request to ${url} failed: ${message}`, {
      status: 502,
      code: "network_error",
    });
  }

  if (!res.ok) {
    throw new UpstreamError(`openrouter catalog request to ${url} responded ${res.status}`, {
      status: res.status,
      code: `http_${res.status}`,
    });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`openrouter catalog response body from ${url} could not be read: ${message}`, {
      status: 502,
      code: "network_error",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError(`openrouter catalog response from ${url} is not valid JSON`, {
      status: 502,
      code: "upstream_error",
    });
  }
  const data = isRecord(parsed) ? parsed["data"] : undefined;
  if (!Array.isArray(data)) {
    throw new UpstreamError(`openrouter catalog response from ${url} is missing a "data" array`, {
      status: 502,
      code: "upstream_error",
    });
  }

  const mapped: ModelSpec[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) {
      options.logger.warn("openrouter catalog: skipped a non-object entry");
      continue;
    }
    const modelId = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    if (modelId.length === 0) {
      options.logger.warn("openrouter catalog: skipped an entry without a usable 'id'");
      continue;
    }
    const spec = mapCatalogEntry(entry, options.sourceId);
    if (spec === undefined) {
      // Not free — the normal case on OpenRouter; no warning needed.
      continue;
    }
    mapped.push(spec);
  }

  return filterCatalogSpecs(mapped, options);
}
