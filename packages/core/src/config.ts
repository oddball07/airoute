import { readFile } from "node:fs/promises";
import { ConfigError } from "./errors.js";
import { DEFAULT_CATALOG_TTL_MS } from "./registry.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ServerConfig {
  host: string;
  port: number;
}

/** One entry of `sources.registry`. Extra keys are per-source options. */
export interface SourceConfigEntry {
  type: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface RankWeights {
  uptime: number;
  quota: number;
  latency: number;
  context: number;
  capability: number;
}

/**
 * Optional `monitor` section: health-probe + breaker tuning.
 * All fields defaulted; the whole section may be omitted.
 */
export interface MonitorConfig {
  /** Master switch: when false, part 2 wiring disables probes entirely. */
  enabled: boolean;
  /** Base per-source probe cadence (ms); integer >= 10000. */
  probeEveryMs: number;
  /** Max random jitter added to each cadence (ms); integer 0..600000. */
  jitterMs: number;
  /** Rolling window (ms) for counting request failures toward degrade. */
  requestFailureWindowMs: number;
  /** Base cooldown (ms) for 429/capacity cool-downs (doubles, capped 30 min). */
  cooldownMs: number;
}

export interface AirouteConfig {
  $schema?: string;
  server: ServerConfig;
  sources: {
    registry: SourceConfigEntry[];
    /** Freshness window for cached per-source model catalogs, ms; 0 disables caching. */
    cacheTtlMs?: number;
  };
  rank: { weights: RankWeights };
  aliases: Record<string, string[]>;
  monitor?: MonitorConfig;
}

/** Result of `loadConfig`. `fileFound` reports whether the file existed on disk. */
export interface LoadedConfig {
  config: AirouteConfig;
  /** The path that was consulted. */
  path: string;
  /** False when the file was missing and built-in defaults were returned. */
  fileFound: boolean;
  /** Non-fatal issues (e.g. unknown-but-disabled source types). */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Well-known sources                                                         */
/* -------------------------------------------------------------------------- */

/** Source types the Phase 0 schema knows about. New sources extend this. */
export const KNOWN_SOURCE_TYPES: readonly string[] = ["mock", "zai", "openrouter"];

/** Environment variable each well-known source type requires (`""` = none). */
export const SOURCE_ENV_KEYS: Readonly<Record<string, string>> = {
  mock: "",
  zai: "ZAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Env-var name required by a source type, or `""` when the type needs no key. */
export function envKeyForType(type: string): string {
  return SOURCE_ENV_KEYS[type] ?? "";
}

/* -------------------------------------------------------------------------- */
/* Defaults (mirror config/airoute.json)                                      */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CONFIG_PATH = "config/airoute.json";
export const DEFAULT_SERVER = { host: "127.0.0.1", port: 8787 };
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  uptime: 0.35,
  quota: 0.25,
  latency: 0.2,
  context: 0.1,
  capability: 0.1,
};
/** Registry entry defaults. `cacheTtlMs` controls catalog caching (0 disables it). */
export const DEFAULT_SOURCE_ENTRIES: readonly SourceConfigEntry[] = [
  { type: "mock", enabled: false },
  { type: "zai", enabled: false },
  { type: "openrouter", enabled: false },
];
export const DEFAULT_ALIASES: Record<string, string[]> = {
  "free-best": [],
  "free-coder": [],
  "free-fast": [],
};

/** Monitor section defaults (module-level constants live in @airoute/monitor). */
export const DEFAULT_MONITOR: MonitorConfig = {
  enabled: true,
  probeEveryMs: 900_000,
  jitterMs: 60_000,
  requestFailureWindowMs: 600_000,
  cooldownMs: 300_000,
};

export function defaultConfig(): AirouteConfig {
  return {
    server: { ...DEFAULT_SERVER },
    sources: {
      registry: DEFAULT_SOURCE_ENTRIES.map((entry) => ({ ...entry })),
      cacheTtlMs: DEFAULT_CATALOG_TTL_MS,
    },
    rank: { weights: { ...DEFAULT_RANK_WEIGHTS } },
    aliases: structuredClone(DEFAULT_ALIASES),
    monitor: { ...DEFAULT_MONITOR },
  };
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

export interface LoadConfigOptions {
  /**
   * Types registered in the running process. When set, an enabled entry of an
   * unregistered type fails; a *disabled* entry never fails (warning only).
   */
  knownTypes?: readonly string[];
}

/** Load and validate the config file. A missing file yields built-in defaults. */
export async function loadConfig(
  path: string = process.env["AIRROUTE_CONFIG"] ?? DEFAULT_CONFIG_PATH,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isMissingFile(err)) {
      return { config: defaultConfig(), path, fileFound: false, warnings: [] };
    }
    throw new ConfigError(`${path}: cannot read config file (${describe(err)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path}: not valid JSON — ${describe(err)}`);
  }

  const { config, warnings } = normalizeConfig(parsed, path, options.knownTypes);
  return { config, path, fileFound: true, warnings };
}

/* -------------------------------------------------------------------------- */
/* Validation / normalization                                                 */
/* -------------------------------------------------------------------------- */

function normalizeConfig(
  raw: unknown,
  path: string,
  knownTypes?: readonly string[],
): { config: AirouteConfig; warnings: string[] } {
  const warnings: string[] = [];
  function fail(jsonPath: string, message: string): never {
    throw new ConfigError(`${path}: config invalid at "${jsonPath}" — ${message}`);
  }

  if (!isRecord(raw)) fail("$", "top level must be a JSON object");

  // server ------------------------------------------------------------------
  const rawServer = raw["server"];
  let server: ServerConfig;
  if (rawServer === undefined) {
    server = { ...DEFAULT_SERVER };
  } else if (isRecord(rawServer)) {
    const host = rawServer["host"] === undefined ? DEFAULT_SERVER.host : rawServer["host"];
    if (typeof host !== "string" || host.length === 0) fail("server.host", "must be a non-empty string");
    const port = rawServer["port"] === undefined ? DEFAULT_SERVER.port : rawServer["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail("server.port", "must be an integer between 1 and 65535");
    }
    server = { host, port: port as number };
  } else {
    fail("server", "must be an object");
  }

  // sources -------------------------------------------------------------------
  const rawSources = raw["sources"];
  let registry: SourceConfigEntry[];
  let cacheTtlMs = DEFAULT_CATALOG_TTL_MS;
  if (rawSources === undefined) {
    registry = DEFAULT_SOURCE_ENTRIES.map((entry) => ({ ...entry }));
  } else if (isRecord(rawSources)) {
    const rawCacheTtl = rawSources["cacheTtlMs"];
    if (rawCacheTtl !== undefined) {
      if (
        typeof rawCacheTtl !== "number" ||
        !Number.isInteger(rawCacheTtl) ||
        rawCacheTtl < 0
      ) {
        fail(
          "sources.cacheTtlMs",
          "must be a non-negative integer (milliseconds; 0 disables catalog caching)",
        );
      }
      cacheTtlMs = rawCacheTtl;
    }
    const rawRegistry = rawSources["registry"];
    if (rawRegistry === undefined) {
      registry = DEFAULT_SOURCE_ENTRIES.map((entry) => ({ ...entry }));
    } else if (Array.isArray(rawRegistry)) {
      registry = rawRegistry.map((entry, index) => {
        if (!isRecord(entry)) fail(`sources.registry[${index}]`, "must be an object");
        const type = entry["type"];
        if (typeof type !== "string" || type.length === 0) {
          fail(`sources.registry[${index}].type`, "must be a non-empty string");
        }
        const enabled = entry["enabled"] === undefined ? false : entry["enabled"];
        if (typeof enabled !== "boolean") {
          fail(`sources.registry[${index}].enabled`, "must be a boolean");
        }
        const unknownMessage = `unknown source type "${type}"` +
          (knownTypes !== undefined
            ? ` (registered: ${knownTypes.join(", ")})`
            : ` (known: ${KNOWN_SOURCE_TYPES.join(", ")})`);
        if (enabled && !(knownTypes ?? KNOWN_SOURCE_TYPES).includes(type)) {
          fail(`sources.registry[${index}].type`, `${unknownMessage}; disabled entries are allowed but ignored`);
        }
        if (enabled === false && !(knownTypes ?? KNOWN_SOURCE_TYPES).includes(type)) {
          warnings.push(`ignored disabled source type "${type}" (unknown)`);
        }
        return { ...entry, type, enabled };
      });
    } else {
      fail("sources.registry", "must be an array");
    }
  } else {
    fail("sources", "must be an object");
  }

  // rank.weights ------------------------------------------------------------
  const rawRank = raw["rank"];
  let rank: AirouteConfig["rank"];
  if (rawRank === undefined) {
    rank = { weights: { ...DEFAULT_RANK_WEIGHTS } };
  } else if (isRecord(rawRank)) {
    const rawWeights = rawRank["weights"];
    if (rawWeights === undefined) {
      rank = { weights: { ...DEFAULT_RANK_WEIGHTS } };
    } else if (isRecord(rawWeights)) {
      const weights = { ...DEFAULT_RANK_WEIGHTS };
      for (const key of Object.keys(DEFAULT_RANK_WEIGHTS) as (keyof RankWeights)[]) {
        const value = rawWeights[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          fail(`rank.weights.${key}`, "must be a number between 0 and 1");
        }
        weights[key] = value as number;
      }
      rank = { weights };
    } else {
      fail("rank.weights", "must be an object");
    }
  } else {
    fail("rank", "must be an object");
  }

  // aliases -----------------------------------------------------------------
  const rawAliases = raw["aliases"];
  let aliases: Record<string, string[]>;
  if (rawAliases === undefined) {
    aliases = structuredClone(DEFAULT_ALIASES);
  } else if (isRecord(rawAliases)) {
    aliases = {};
    for (const [name, value] of Object.entries(rawAliases)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        fail(`aliases["${name}"]`, "must be an array of model-id strings");
      }
      aliases[name] = (value as unknown[]).filter((item): item is string => typeof item === "string");
    }
  } else {
    fail("aliases", "must be an object");
  }

  // monitor ----------------------------------------------------------------
  const rawMonitor = raw["monitor"];
  let monitor: MonitorConfig | undefined;
  if (rawMonitor === undefined) {
    monitor = undefined; // omitted section → runtime defaults (DEFAULT_MONITOR)
  } else if (isRecord(rawMonitor)) {
    const enabled = rawMonitor["enabled"] === undefined ? DEFAULT_MONITOR.enabled : rawMonitor["enabled"];
    if (typeof enabled !== "boolean") fail("monitor.enabled", "must be a boolean");
    const probeEveryMs =
      rawMonitor["probeEveryMs"] === undefined ? DEFAULT_MONITOR.probeEveryMs : rawMonitor["probeEveryMs"];
    if (typeof probeEveryMs !== "number" || !Number.isInteger(probeEveryMs) || probeEveryMs < 10_000) {
      fail("monitor.probeEveryMs", "must be an integer >= 10000 (milliseconds)");
    }
    const jitterMs = rawMonitor["jitterMs"] === undefined ? DEFAULT_MONITOR.jitterMs : rawMonitor["jitterMs"];
    if (
      typeof jitterMs !== "number" ||
      !Number.isInteger(jitterMs) ||
      jitterMs < 0 ||
      jitterMs > 600_000
    ) {
      fail("monitor.jitterMs", "must be an integer between 0 and 600000 (milliseconds)");
    }
    const requestFailureWindowMs =
      rawMonitor["requestFailureWindowMs"] === undefined
        ? DEFAULT_MONITOR.requestFailureWindowMs
        : rawMonitor["requestFailureWindowMs"];
    if (
      typeof requestFailureWindowMs !== "number" ||
      !Number.isInteger(requestFailureWindowMs) ||
      requestFailureWindowMs < 1
    ) {
      fail("monitor.requestFailureWindowMs", "must be a positive integer (milliseconds)");
    }
    const cooldownMs =
      rawMonitor["cooldownMs"] === undefined ? DEFAULT_MONITOR.cooldownMs : rawMonitor["cooldownMs"];
    if (typeof cooldownMs !== "number" || !Number.isInteger(cooldownMs) || cooldownMs < 1) {
      fail("monitor.cooldownMs", "must be a positive integer (milliseconds)");
    }
    monitor = {
      enabled: enabled as boolean,
      probeEveryMs: probeEveryMs as number,
      jitterMs: jitterMs as number,
      requestFailureWindowMs: requestFailureWindowMs as number,
      cooldownMs: cooldownMs as number,
    };
  } else {
    fail("monitor", "must be an object");
  }

  const schemaValue = raw["$schema"];
  const config: AirouteConfig = { server, sources: { registry, cacheTtlMs }, rank, aliases };
  if (typeof schemaValue === "string") config.$schema = schemaValue;
  if (monitor !== undefined) config.monitor = monitor;

  return { config, warnings };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
