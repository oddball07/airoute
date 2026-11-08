#!/usr/bin/env node
/**
 * Deterministic OpenCode gate gateway (Phase 3 verification helper).
 *
 * Starts a real AIRoute gateway on a local port with three fake sources, so
 * `opencode run` can exercise the two gate scenarios that are hard to force
 * against live providers:
 *
 *   free-failover  → flaky/a (429) then steady/a   → expect "STEADY-OK"
 *   free-degraded  → dead/a (cooling) skipped, steady/a → expect "STEADY-OK"
 *
 * No network, no API keys. Point OpenCode's config at the printed URL:
 *
 *   node scripts/opencode-gate-gateway.mjs
 *   node packages/cli/dist/cli.js install-opencode --project <dir> --url http://127.0.0.1:8799
 *   (cd <dir>; opencode run --standalone --model airoute/free-failover "Reply ...")
 *
 * Env: AIROUTE_GATE_PORT (default 8799), AIROUTE_LOG=debug for routing logs.
 */
import { UpstreamError, createLogger, createSourceRegistry } from "@airoute/core";
import { startGateway } from "@airoute/gateway";
import { HealthTracker, createInMemoryStore } from "@airoute/monitor";

const PORT = Number(process.env["AIROUTE_GATE_PORT"] ?? 8799);

/** @param {string} sourceId @param {string} name */
function spec(sourceId, name) {
  return {
    id: `${sourceId}/${name}`,
    sourceId,
    sourceModelId: name,
    label: `${sourceId} ${name}`,
    contextWindow: 8192,
    caps: { tools: true, vision: false, reasoning: false },
    free: true,
    aliases: [],
  };
}

/** @param {string} text */
function okStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ index: 0, role: "assistant" });
      controller.enqueue({ index: 1, content: text });
      controller.enqueue({ index: 2, finishReason: "stop", done: true });
      controller.close();
    },
  });
}

const probeOk = async () => ({ ok: true, latencyMs: 1, at: new Date().toISOString() });

/** Always fails the first attempt; the gateway must silently fail over. */
const flaky = {
  id: "flaky",
  listModels: async () => [spec("flaky", "a")],
  stream: async () => {
    throw new UpstreamError("simulated upstream overload", {
      status: 429,
      code: "rate_limit_exceeded",
    });
  },
  probe: probeOk,
};

/** Would answer "DEAD-OK" if the breaker did not skip it. */
const dead = {
  id: "dead",
  listModels: async () => [spec("dead", "a")],
  stream: async () => okStream("DEAD-OK"),
  probe: probeOk,
};

const steady = {
  id: "steady",
  listModels: async () => [spec("steady", "a")],
  stream: async () => okStream("STEADY-OK"),
  probe: probeOk,
};

const registry = createSourceRegistry();
registry.registerAll([flaky, dead, steady]);

const store = createInMemoryStore();
const health = new HealthTracker({ store });
// Cool the "dead" model so the gateway must skip it during candidate selection.
health.recordProbe({ sourceId: "dead", modelId: "dead/a", ok: false, errorKind: "capacity" });

const gateway = await startGateway({
  registry,
  aliasMap: {
    "free-failover": ["flaky/a", "steady/a"],
    "free-degraded": ["dead/a", "steady/a"],
  },
  health,
  host: "127.0.0.1",
  port: PORT,
  installShutdownHandlers: false,
  logger: createLogger({ scope: "airoute:gate" }),
});

const address = gateway.server.address();
const url = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "?";
console.log(`gate gateway listening on ${url}`);
console.log("aliases: free-failover (429 → steady), free-degraded (cooling skipped)");

async function shutdown() {
  await gateway.stop();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGBREAK", () => void shutdown());
