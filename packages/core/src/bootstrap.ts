/**
 * Building a populated `SourceRegistry` from config.
 *
 * Source packages export a `SourceFactory`; the process entrypoint (CLI)
 * hands a `{ type -> factory }` map to `buildRegistry()` along with the
 * loaded config. Well-known types need their env key present (`zai` needs
 * `ZAI_API_KEY`, `openrouter` needs `OPENROUTER_API_KEY`); a missing key
 * disables the source with a readable log line instead of failing startup.
 */
import type { AirouteConfig, SourceConfigEntry } from "./config.js";
import { envKeyForType } from "./config.js";
import { DEFAULT_CATALOG_TTL_MS } from "./registry.js";
import { createLogger, type Logger } from "./log.js";
import { SourceRegistry } from "./registry.js";
import type { Source } from "./types.js";

/** Factory for one source plugin; receives its config entry (may carry extra options). */
export type SourceFactory = (entry: SourceConfigEntry) => Source | Promise<Source>;

export interface RegistryBuild {
  registry: SourceRegistry;
  /** Types that got registered, in config order. */
  enabled: string[];
  /** Entries skipped at runtime, with the reason. */
  skipped: Array<{ type: string; reason: string }>;
  /** Entries present-but-disabled in config. */
  disabled: string[];
}

export interface BuildRegistryOptions {
  config: AirouteConfig;
  /** Map of type → factory. Types missing here are skipped with a warning. */
  factories?: Readonly<Record<string, SourceFactory>>;
  logger?: Logger;
  /** Environment used for key checks; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export async function buildRegistry(options: BuildRegistryOptions): Promise<RegistryBuild> {
  const { config } = options;
  const logger =
    options.logger ??
    createLogger({ scope: "airoute:registry" });
  const env = options.env ?? process.env;
  const factories = options.factories ?? {};

  const registry = new SourceRegistry(logger.child("registry"), {
    cacheTtlMs: config.sources.cacheTtlMs ?? DEFAULT_CATALOG_TTL_MS,
  });
  const enabled: string[] = [];
  const disabled: string[] = [];
  const skipped: RegistryBuild["skipped"] = [];

  for (const entry of config.sources.registry) {
    if (!entry.enabled) {
      disabled.push(entry.type);
      logger.debug(`source '${entry.type}' disabled in config`);
      continue;
    }
    const envKey = envKeyForType(entry.type);
    if (envKey.length > 0 && !env[envKey]) {
      const reason = `no key`;
      skipped.push({ type: entry.type, reason });
      logger.warn(`source '${entry.type}' disabled: no key (${envKey} is not set)`);
      continue;
    }
    const factory = factories[entry.type];
    if (!factory) {
      const reason = `no plugin registered for type '${entry.type}'`;
      skipped.push({ type: entry.type, reason });
      logger.warn(`source '${entry.type}' enabled but skipped: ${reason}`);
      continue;
    }
    try {
      const source = await factory(entry);
      registry.register(source);
      enabled.push(entry.type);
      logger.info(`source '${entry.type}' enabled (id: ${source.id})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ type: entry.type, reason });
      logger.warn(`source '${entry.type}' disabled: failed to initialize (${reason})`);
    }
  }

  return { registry, enabled, skipped, disabled };
}
