/**
 * Pure builders for the OpenCode provider config.
 *
 * This module never touches the filesystem: callers hand in the existing
 * config (parsed `unknown`) and the free-model catalog, and get back the merged
 * config object. The `airoute` provider block is replaced wholesale on every
 * build (idempotent); every other top-level key and provider is preserved so
 * the user's OpenCode settings survive the round-trip.
 */
import type { ModelCaps, ModelSpec } from "@airoute/core";
import { isRecord } from "./jsonc.js";

/** OpenCode custom-provider package that speaks the OpenAI wire protocol. */
const OPENCODE_OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";
/** Provider key inside `providers` — the selectable model id is `airoute/<key>`. */
export const AIROUTE_PROVIDER_ID = "airoute";
/** Default alias used as the OpenCode default model when none is requested. */
export const DEFAULT_OPENCODE_MODEL = "free-best";
/** Context limit written for alias entries (aliases rank across models). */
const ALIAS_CONTEXT_LIMIT = 200_000;

export interface BuildOpencodeConfigOptions {
  /** Model specs from the gateway catalog. Already free, but re-checked here. */
  specs: readonly ModelSpec[];
  /** Config alias names to expose as selectable `airoute/<alias>` models. */
  aliases: readonly string[];
  /** Gateway base URL (appended with `/v1` unless already present). */
  gatewayUrl: string;
  /** Alias or gateway model id for the root `model` key. Default `free-best`. */
  defaultModel?: string;
}

/** The OpenCode JSON schema version we emit. */
export function opencodeSchema(): string {
  return OPENCODE_SCHEMA;
}

/**
 * Normalize a gateway base URL: trim trailing slashes and append `/v1` unless
 * the path already ends with it. `normalizeGatewayBaseUrl("http://h:8787/v1/")`
 * → `"http://h:8787/v1"`.
 */
export function normalizeGatewayBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

/**
 * Convert a `/v1/models` gateway payload into free-only `ModelSpec`s.
 * Free models only: entries with `free !== true` are dropped. Throws on a
 * malformed payload (non-object body, missing `data` array, or a data entry
 * that is not an object with a non-empty string id).
 */
export function gatewayCatalogToSpecs(payload: unknown): ModelSpec[] {
  if (!isRecord(payload)) throw new Error("gateway catalog: payload must be a JSON object");
  const data = payload["data"];
  if (!Array.isArray(data)) throw new Error('gateway catalog: missing "data" array');
  const specs: ModelSpec[] = [];
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (!isRecord(entry)) {
      throw new Error(`gateway catalog: data[${i}] must be a JSON object`);
    }
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`gateway catalog: data[${i}].id must be a non-empty string`);
    }
    // Free models only — this is the hard gate for the OpenCode install path.
    if (entry["free"] !== true) continue;

    // OpenCode model keys may contain `/` but never `#`, which its model-id
    // grammar reserves for the variant suffix (`provider/model#variant`).
    if (id.includes("#")) {
      throw new Error(
        `gateway catalog: data[${i}].id "${id}" contains "#", which is not allowed in OpenCode model keys`,
      );
    }

    const ownedBy = entry["owned_by"];
    const sourceId =
      typeof ownedBy === "string" && ownedBy.length > 0
        ? ownedBy
        : (id.split("/", 1)[0] ?? id);
    const sourceModelId = id.startsWith(`${sourceId}/`) ? id.slice(sourceId.length + 1) : id;

    const rawLabel = entry["label"];
    const label = typeof rawLabel === "string" && rawLabel.length > 0 ? rawLabel : id;

    const rawContext = entry["context_window"];
    const contextWindow = typeof rawContext === "number" && Number.isFinite(rawContext) && rawContext > 0 ? rounded(rawContext) : 0;

    const caps = parseCaps(entry["caps"], `gateway catalog: data[${i}].caps`);

    const rawAliases = entry["aliases"];
    const aliases = rawAliases === undefined ? [] : parseAliases(rawAliases, `gateway catalog: data[${i}].aliases`);

    specs.push({
      id,
      sourceId,
      sourceModelId,
      label,
      contextWindow,
      caps,
      free: true,
      aliases,
      ...(isRecord(entry["meta"]) ? { meta: entry["meta"] } : {}),
    });
  }
  return specs;
}

function rounded(value: number): number {
  return Number.isInteger(value) ? value : Math.round(value);
}

function parseCaps(value: unknown, where: string): ModelCaps {
  if (value === undefined) return { tools: false, vision: false, reasoning: false };
  if (!isRecord(value)) throw new Error(`${where} must be a JSON object`);
  return {
    tools: value["tools"] === true,
    vision: value["vision"] === true,
    reasoning: value["reasoning"] === true,
  };
}

function parseAliases(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of strings`);
  const aliases: string[] = [];
  for (const alias of value) {
    if (typeof alias !== "string" || alias.length === 0) {
      throw new Error(`${where} must contain only non-empty strings`);
    }
    aliases.push(alias);
  }
  return aliases;
}

/** Free-only defense: throw when a non-free spec sneaks through. */
function assertFree(spec: ModelSpec): void {
  if (spec.free !== true) {
    throw new Error(`refusing non-free model "${spec.id}": AIRoute routes free models only`);
  }
}

/** Build just the `providers.airoute` block. Stable key order, idempotent. */
export function buildAirouteProvider(
  options: Pick<BuildOpencodeConfigOptions, "specs" | "aliases" | "gatewayUrl">,
): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const spec of options.specs) {
    assertFree(spec);
    models[spec.id] = modelEntry(spec);
  }
  for (const alias of options.aliases) {
    models[alias] = aliasEntry(alias);
  }
  return {
    name: "AIRoute",
    package: OPENCODE_OPENAI_COMPATIBLE_PACKAGE,
    settings: {
      baseURL: normalizeGatewayBaseUrl(options.gatewayUrl),
      apiKey: "airoute",
    },
    models: sortKeys(models),
  };
}

function modelEntry(spec: ModelSpec): Record<string, unknown> {
  assertFree(spec);
  const input = ["text"];
  if (spec.caps.vision) input.push("image");
  const capabilities: Record<string, unknown> = {
    tools: spec.caps.tools,
    input,
    output: ["text"],
  };
  if (spec.caps.reasoning) capabilities["reasoning"] = { supported: true };
  const entry: Record<string, unknown> = {
    modelID: spec.id,
    name: spec.label.length > 0 ? spec.label : spec.id,
    capabilities,
  };
  if (spec.contextWindow > 0) entry["limit"] = { context: spec.contextWindow };
  entry["cost"] = { input: 0, output: 0 };
  return entry;
}

function aliasEntry(alias: string): Record<string, unknown> {
  return {
    modelID: alias,
    name: alias,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: ALIAS_CONTEXT_LIMIT },
  };
}

/**
 * Merge the AIRoute provider into an existing OpenCode config.
 *
 * - `$schema` is added only when absent.
 * - Everything else top-level is preserved verbatim (spread), and unknown
 *   providers under `providers` survive untouched.
 * - The root `model` key is set to `airoute/<defaultModel>` ONLY when the
 *   existing config has no `model` key.
 */
export function buildOpencodeConfig(
  existing: unknown,
  options: BuildOpencodeConfigOptions,
): Record<string, unknown> {
  const config: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  if (!("$schema" in config)) config["$schema"] = OPENCODE_SCHEMA;
  const providers = isRecord(config["providers"]) ? config["providers"] : undefined;
  config["providers"] = {
    ...(providers ?? {}),
    [AIROUTE_PROVIDER_ID]: buildAirouteProvider(options),
  };
  if (!("model" in config)) {
    config["model"] = `${AIROUTE_PROVIDER_ID}/${options.defaultModel ?? DEFAULT_OPENCODE_MODEL}`;
  }
  return config;
}

/** Stable, deterministic key order (plain codepoint sort). */
function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}
