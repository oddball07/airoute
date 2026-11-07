#!/usr/bin/env node
/**
 * AIRoute CLI.
 *
 *   airoute serve [--port N] [--host H] [--config PATH]
 *   airoute models [--config PATH]
 *
 * Hand-rolled argv parsing; no dependencies beyond the AIRoute packages.
 */
import {
  AIRROUTE_VERSION,
  ConfigError,
  buildRegistry,
  createLogger,
  loadConfig,
  type AirouteConfig,
  type Logger,
} from "@airoute/core";
import { startGateway } from "@airoute/gateway";

const USAGE = `airoute ${AIRROUTE_VERSION} — local gateway between CLI agents and free AI sources

Usage:
  airoute serve [--port N] [--host H] [--config PATH]   start the gateway
  airoute models [--config PATH]                        list the free catalog
  airoute help                                          show this help

Env:
  AIRROUTE_CONFIG   default config path (config/airoute.json)
  AIRROUTE_LOG=debug  verbose logging`;

interface ParsedArgs {
  command: string | null;
  options: Map<string, string | boolean>;
  errors: string[];
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const options = new Map<string, string | boolean>();
  const errors: string[] = [];
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(key, next);
        i++;
      } else {
        options.set(key, true);
      }
    } else if (command === null) {
      command = token;
    } else {
      errors.push(`unexpected argument: ${token}`);
    }
  }
  return { command, options, errors };
}

function numberOption(options: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = options.get(name);
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(`invalid --${name} value: "${value}" (must be an integer 1..65535)`);
  }
  return parsed;
}

function stringOption(options: Map<string, string | boolean>, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, options, errors } = parseArgv(argv);
  if (errors.length > 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  switch (command ?? "help") {
    case "serve":
      await runServe(options);
      return;
    case "models":
      await runModels(options);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
  }
}

async function loadOrExit(
  options: Map<string, string | boolean>,
  logger: Logger,
): Promise<{ config: AirouteConfig; configPath: string }> {
  const configPath = stringOption(options, "config");
  try {
    const loaded = await loadConfig(configPath);
    for (const warning of loaded.warnings) logger.warn(`config: ${warning}`, { path: loaded.path });
    return { config: loaded.config, configPath: loaded.path };
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(`cannot start: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

async function runServe(options: Map<string, string | boolean>): Promise<void> {
  const logger = createLogger({ scope: "airoute" });
  const { config, configPath } = await loadOrExit(options, logger);

  let host = config.server.host;
  const hostOverride = stringOption(options, "host");
  if (hostOverride !== undefined && hostOverride.length > 0) host = hostOverride;
  const port = numberOption(options, "port", config.server.port);

  // Phase 0 registers no source plugins in the CLI; source packages (mock/zai/
  // openrouter) plug in here as they land. Enabled-but-unregistered types are
  // skipped with a warning instead of failing startup.
  const build = await buildRegistry({ config, factories: {}, logger: logger.child("sources") });

  logger.info("starting airoute gateway", {
    version: AIRROUTE_VERSION,
    config: configPath,
    host,
    port,
  });
  logger.info("sources", {
    enabled: build.enabled,
    disabled: build.disabled,
    skipped: build.skipped,
  });

  const gateway = await startGateway({
    registry: build.registry,
    aliasMap: config.aliases,
    host,
    port,
    logger: logger.child("gateway"),
  });
  logger.info(`gateway listening at http://${gateway.host}:${gateway.port}`, {
    endpoints: ["/healthz", "/v1/models", "/v1/chat/completions"],
  });
  // startGateway installs SIGINT/SIGTERM/SIGBREAK shutdown handlers by default.
}

async function runModels(options: Map<string, string | boolean>): Promise<void> {
  const logger = createLogger({ scope: "airoute" });
  const { config, configPath } = await loadOrExit(options, logger);

  const build = await buildRegistry({ config, factories: {}, logger: logger.child("sources") });
  const specs = await build.registry.models();

  if (specs.length === 0) {
    console.log(`no models (config: ${configPath}; enable a source in your config)`);
    return;
  }
  const sorted = [...specs].sort((a, b) => a.id.localeCompare(b.id));
  const idWidth = Math.max("MODEL ID".length, ...sorted.map((spec) => spec.id.length));
  const sourceWidth = Math.max("SOURCE".length, ...sorted.map((spec) => spec.sourceId.length));
  const contextWidth = Math.max("CONTEXT".length, ...sorted.map((spec) => String(spec.contextWindow).length));
  const aliasesWidth = Math.max("ALIASES".length, ...sorted.map((spec) => spec.aliases.join(", ").length));

  const header =
    `MODEL ID`.padEnd(idWidth + 2) +
    `SOURCE`.padEnd(sourceWidth + 2) +
    `CONTEXT`.padEnd(contextWidth + 2) +
    `ALIASES`.padEnd(aliasesWidth);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const spec of sorted) {
    console.log(
      spec.id.padEnd(idWidth + 2) +
        spec.sourceId.padEnd(sourceWidth + 2) +
        String(spec.contextWindow).padEnd(contextWidth + 2) +
        spec.aliases.join(", ").padEnd(aliasesWidth),
    );
  }
}

await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
