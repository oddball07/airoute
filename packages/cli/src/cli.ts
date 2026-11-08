#!/usr/bin/env node
/**
 * AIRoute CLI.
 *
 *   airoute serve [--port N] [--host H] [--config PATH]
 *   airoute models [--config PATH]
 *   airoute status [--config PATH]
 *   airoute install-opencode [--project [DIR]] [--config PATH] [--url URL]
 *                            [--model NAME] [--dry-run]
 *
 * Hand-rolled argv parsing; no dependencies beyond the AIRoute packages.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  AIRROUTE_VERSION,
  ConfigError,
  DEFAULT_MONITOR,
  buildRegistry,
  createLogger,
  loadConfig,
  resolveCandidates,
  type AirouteConfig,
  type Logger,
  type ModelSpec,
  type SourceFactory,
} from "@airoute/core";
import { startGateway } from "@airoute/gateway";
import { fetchGatewayCatalog, globalOpencodeConfigPath, installOpencode, projectOpencodeConfigPath } from "@airoute/opencode";
import { HealthTracker, MetricsStore, rankModels, type RankInput } from "@airoute/monitor";
import { createOpenRouterSourceFactory } from "@airoute/openrouter";
import { createZaiSourceFactory } from "@airoute/zai";
import { RANK_WINDOW_MS, createRanker, metricsDbPath, startMonitor } from "./monitor-runtime.js";
import { clientConnectableGatewayUrl } from "./gateway-url.js";

/**
 * Type-name → factory wiring. `packages/sources/<name>` packages register
 * here as they land. Enabled-but-unregistered types are skipped with a
 * warning instead of failing startup.
 */
const SOURCE_FACTORIES: Readonly<Record<string, SourceFactory>> = {
  zai: createZaiSourceFactory,
  openrouter: createOpenRouterSourceFactory,
};

const USAGE = `airoute ${AIRROUTE_VERSION} — local gateway between CLI agents and free AI sources

Usage:
  airoute serve [--port N] [--host H] [--config PATH]   start the gateway
  airoute models [--config PATH]                        list the free catalog
  airoute status [--config PATH]                        rank free models by health
  airoute install-opencode [--project [DIR]] [--config PATH]
                            [--url URL] [--model NAME] [--dry-run]
                                                        write the OpenCode provider config
  airoute help                                          show this help

Env:
  AIRROUTE_CONFIG   default config path (config/airoute.json)
  AIRROUTE_DB       metrics database path (data/airoute.db)
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
    case "status":
      await runStatus(options);
      return;
    case "install-opencode":
      await runInstallOpencode(options);
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

  const build = await buildRegistry({ config, factories: SOURCE_FACTORIES, logger: logger.child("sources") });

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

  // Phase 2: metrics store + breaker + probe scheduler. Opening the store
  // also restores persisted breaker state, so routing starts from the last
  // known health even before the first probe cycle.
  const monitor = startMonitor(config, build.registry.all(), logger.child("monitor"));
  process.once("exit", () => monitor.store.close());
  const monitorConfig = config.monitor ?? DEFAULT_MONITOR;
  logger.info("monitor", {
    enabled: monitor.enabled,
    db: monitor.dbPath,
    probeEveryMs: monitorConfig.probeEveryMs,
    jitterMs: monitorConfig.jitterMs,
    sources: build.enabled.length,
  });

  const gateway = await startGateway({
    registry: build.registry,
    aliasMap: config.aliases,
    health: monitor.health,
    ranker: monitor.ranker,
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

  const build = await buildRegistry({ config, factories: SOURCE_FACTORIES, logger: logger.child("sources") });
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

async function runStatus(options: Map<string, string | boolean>): Promise<void> {
  const logger = createLogger({ scope: "airoute" });
  const { config, configPath } = await loadOrExit(options, logger);

  const build = await buildRegistry({ config, factories: SOURCE_FACTORIES, logger: logger.child("sources") });
  const specs = await build.registry.models();
  if (specs.length === 0) {
    console.log(`no models (config: ${configPath}; enable a source in your config)`);
    return;
  }

  const dbPath = metricsDbPath();
  const store = existsSync(dbPath) ? new MetricsStore(dbPath) : undefined;
  try {
    const health = store === undefined ? undefined : new HealthTracker({ store });
    const ranker = createRanker(store, health, config.rank.weights);
    const ranked = rankModels(
      specs.map((spec): RankInput => {
        const stats = store?.getStats(spec.sourceId, spec.id, RANK_WINDOW_MS) ?? null;
        return {
          spec,
          stats,
          state: health?.state(spec.sourceId, spec.id) ?? "healthy",
          lastErrorKind: stats?.lastErrorKind ?? null,
        };
      }),
      config.rank.weights,
    );

    console.log(
      store === undefined
        ? `metrics: ${dbPath} (none yet — run "airoute serve" to collect health data)`
        : `metrics: ${dbPath} — summarizing the last ${Math.round(RANK_WINDOW_MS / 3_600_000)}h`,
    );
    const modelWidth = Math.max("MODEL".length, ...ranked.map((row) => row.spec.id.length));
    const header =
      pad("MODEL", modelWidth + 2) +
      pad("SCORE", 7) +
      pad("STATE", 11) +
      pad("UPTIME", 8) +
      pad("P50", 8) +
      "CONTEXT";
    console.log(header);
    console.log("-".repeat(header.length));
    for (const row of ranked) {
      const stats = store?.getStats(row.spec.sourceId, row.spec.id, RANK_WINDOW_MS) ?? null;
      const rate = stats?.probeSuccessRate ?? stats?.requestSuccessRate ?? null;
      const uptime = rate === null ? "—" : `${Math.round(rate * 100)}%`;
      const p50 =
        stats?.p50Ms === null || stats?.p50Ms === undefined ? "—" : `${Math.round(stats.p50Ms)}ms`;
      const state = health === undefined ? "—" : health.state(row.spec.sourceId, row.spec.id);
      console.log(
        pad(row.spec.id, modelWidth + 2) +
          pad(row.score.toFixed(3), 7) +
          pad(state, 11) +
          pad(uptime, 8) +
          pad(p50, 8) +
          formatContext(row.spec.contextWindow),
      );
    }

    console.log("\naliases:");
    for (const alias of Object.keys(config.aliases)) {
      const resolution = resolveCandidates(specs, alias, {
        aliasMap: config.aliases,
        rankCandidates: ranker,
      });
      const best = resolution.candidates.find((candidate) => candidate.free === true);
      console.log(`  ${pad(alias, 12)}→ ${best?.id ?? "(no free candidate)"}`);
    }
  } finally {
    store?.close();
  }
}

/**
 * Phase 3: write the OpenCode custom-provider config for the AIRoute gateway.
 *
 *   airoute install-opencode [--project [DIR]] [--config PATH]
 *                            [--url URL] [--model NAME] [--dry-run]
 *
 * `--project` with a value targets `<DIR>/opencode.json`; the bare flag targets
 * the cwd. Without the flag the global user config is updated. `--url` pulls
 * the catalog from a running gateway; otherwise the local source registry is
 * used. Free models only — the install path rejects anything else.
 */
async function runInstallOpencode(options: Map<string, string | boolean>): Promise<void> {
  const logger = createLogger({ scope: "airoute" });
  const { config } = await loadOrExit(options, logger);

  const project = options.get("project");
  const target =
    project === true
      ? projectOpencodeConfigPath(process.cwd())
      : typeof project === "string"
        ? projectOpencodeConfigPath(path.resolve(project))
        : globalOpencodeConfigPath();

  const url = stringOption(options, "url");
  let specs: ModelSpec[];
  let gatewayUrl: string;
  let gatewayAliases: string[] = [];
  if (url !== undefined && url.length > 0) {
    const catalog = await fetchGatewayCatalog(url);
    specs = catalog.specs;
    gatewayAliases = catalog.aliases;
    gatewayUrl = url;
  } else {
    // `0.0.0.0`/`::` are bind-anywhere addresses; clients must connect via
    // loopback. An explicit `--url` (the other branch) is used verbatim.
    gatewayUrl = clientConnectableGatewayUrl(config.server.host, config.server.port);
    const build = await buildRegistry({
      config,
      factories: SOURCE_FACTORIES,
      logger: logger.child("sources"),
    });
    specs = await build.registry.models();
  }

  // A remote gateway's own aliases (served by /v1/models) plus the local
  // config's aliases; dedupe so an install never writes the same model twice.
  const aliases = [...new Set([...gatewayAliases, ...Object.keys(config.aliases)])];
  const defaultModel = stringOption(options, "model")?.replace(/^airoute\//, "");
  const modelArg = defaultModel !== undefined ? { defaultModel } : {};
  const dryRun = options.get("dry-run") === true;

  const result = await installOpencode({
    configPath: target,
    specs,
    aliases,
    gatewayUrl,
    ...modelArg,
    dryRun,
  });

  console.log(`target:  ${result.path}`);
  console.log(
    result.created
      ? "action:  create new config"
      : result.changed
        ? "action:  update existing config"
        : "action:  none (already up to date)",
  );
  if (result.backupPath !== undefined) console.log(`backup:  ${result.backupPath}`);
  console.log(`models:  ${result.modelCount} free model(s) exposed as airoute/<id-or-alias>`);
  console.log(
    `aliases: ${aliases.length > 0 ? aliases.join(", ") : "(none — set \"aliases\" in the airoute config)"}`,
  );
  if (specs.length === 0) {
    console.log("note:    no free models in the catalog; only aliases were written");
  }
  if (dryRun) {
    console.log("\ndry run — rendered config (nothing written):");
    console.log(result.content.trimEnd());
    return;
  }
  const model = defaultModel ?? "free-best";
  console.log(
    `\nnext steps:\n  opencode models\n  opencode run --model airoute/${model} "hi"`,
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

function formatContext(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
