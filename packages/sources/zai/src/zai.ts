/**
 * Z.AI (Zhipu AI — api.z.ai / open.bigmodel.cn) source plugin for AIRoute.
 *
 * A thin wrapper over the shared OpenAI-compatible kit
 * (`@airoute/openai-compat`): this module only maps the config entry
 * options (`baseUrl`, `models`, `timeoutMs`) onto kit options plus the
 * `DEFAULT_ZAI_MODELS` list, and supplies the API key from the environment.
 *
 * Config entry (all options optional):
 *
 *     { "type": "zai", "enabled": true, "baseUrl": "…", "models": […], "timeoutMs": 60000 }
 *
 * The source self-skips without a key: `buildRegistry` checks
 * `ZAI_API_KEY` (via `SOURCE_ENV_KEYS`) before this factory is ever called and
 * logs `source 'zai' disabled: no key (ZAI_API_KEY is not set)`. Malformed
 * entry options throw `ConfigError` with a readable message naming the option.
 *
 * API keys are read from the environment only — never from config, never
 * logged, never baked into a spec.
 */
import process from "node:process";
import {
  ConfigError,
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
  type SourceModelDef,
} from "@airoute/openai-compat";
import { DEFAULT_ZAI_MODELS } from "./models.js";

export { DEFAULT_ZAI_MODELS } from "./models.js";

/** Source id used by default (matches `SOURCE_ENV_KEYS.zai`). */
export const DEFAULT_ZAI_SOURCE_ID = "zai";
/** Z.AI OpenAI-compatible base URL; chat lives at `${baseUrl}/chat/completions`. */
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
/** Environment variable carrying the Z.AI API key. */
export const ZAI_ENV_KEY = "ZAI_API_KEY";

export interface ZaiSourceOptions {
  /** Source id; default `DEFAULT_ZAI_SOURCE_ID`. */
  id?: string;
  /** Default `DEFAULT_ZAI_BASE_URL`. */
  baseUrl?: string;
  /** Default `process.env.ZAI_API_KEY`. */
  apiKey?: string;
  /** Override the `DEFAULT_ZAI_MODELS` list entirely. */
  models?: SourceModelDef[];
  /** Idle timeout; default kit default (60 s). */
  timeoutMs?: number;
  /** Extra static headers merged beneath kit headers. */
  headers?: Record<string, string>;
  /** Injectable fetch — the offline-test seam. */
  fetch?: typeof fetch;
}

/**
 * Direct constructor for tests and bespoke wiring. Applies Z.AI defaults and
 * hands off to the shared kit (which validates everything, throwing
 * `ConfigError` on malformed options).
 */
export function createZaiSource(options: ZaiSourceOptions = {}): Source {
  const id = options.id ?? DEFAULT_ZAI_SOURCE_ID;
  const kitOptions: OpenAICompatOptions = {
    id,
    baseUrl: options.baseUrl ?? DEFAULT_ZAI_BASE_URL,
    models: options.models ? [...options.models] : [...DEFAULT_ZAI_MODELS],
    apiKey: options.apiKey !== undefined ? options.apiKey : process.env[ZAI_ENV_KEY],
  };
  if (options.timeoutMs !== undefined) kitOptions.timeoutMs = options.timeoutMs;
  if (options.headers !== undefined) kitOptions.headers = options.headers;
  if (options.fetch !== undefined) kitOptions.fetch = options.fetch;
  return createOpenAICompatSource(kitOptions);
}

/**
 * `SourceFactory` for the `"zai"` source type. Reads extra entry options
 * defensively — anything malformed raises `ConfigError` with a readable
 * message naming the offending option (which `buildRegistry` turns into a
 * skipped-source warning instead of a crash).
 */
export const createZaiSourceFactory: SourceFactory = (entry: SourceConfigEntry): Source => {
  if (typeof entry !== "object" || entry === null) {
    throw new ConfigError(`source '${DEFAULT_ZAI_SOURCE_ID}': config entry must be an object`);
  }
  const options: ZaiSourceOptions = { apiKey: process.env[ZAI_ENV_KEY] };

  const baseUrl = entry["baseUrl"];
  if (baseUrl !== undefined) options.baseUrl = validateBaseUrl(baseUrl, `source '${DEFAULT_ZAI_SOURCE_ID}' option`);

  const models = entry["models"];
  if (models !== undefined) {
    options.models = validateSourceModelDefs(models, `source '${DEFAULT_ZAI_SOURCE_ID}' option`);
  }

  const timeoutMs = entry["timeoutMs"];
  if (timeoutMs !== undefined) {
    options.timeoutMs = validateTimeoutMs(timeoutMs, `source '${DEFAULT_ZAI_SOURCE_ID}' option`);
  }

  return createZaiSource(options);
};
