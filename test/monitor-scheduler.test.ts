/**
 * ProbeScheduler tests — deterministic clock (+ rng), in-memory store, fake
 * sources. No network and no real waiting.
 */
import type { IRChunk, IRRequest, Logger, ModelSpec, ProbeResult, Source } from "@airoute/core";
import {
  createInMemoryStore,
  HealthTracker,
  ProbeScheduler,
  type MetricsStore,
  type ProbeEvent,
} from "@airoute/monitor";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, flush } from "./helpers/fake-clock.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makeStore(): MetricsStore {
  const store = createInMemoryStore();
  cleanups.push(() => store.close());
  return store;
}

/** Logger that captures warnings so silent skips can be asserted. */
function testLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(message: string) {
      warns.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

function spec(sourceId: string, name: string): ModelSpec {
  return {
    id: `${sourceId}/${name}`,
    sourceId,
    sourceModelId: name,
    label: name,
    contextWindow: 8192,
    caps: { tools: false, vision: false, reasoning: false },
    free: true,
    aliases: [],
  };
}

const okProbe = (latencyMs = 5): ProbeResult => ({
  ok: true,
  latencyMs,
  at: new Date().toISOString(),
});

interface FakeSourceOptions {
  id: string;
  models?: ModelSpec[];
  listModels?: () => Promise<ModelSpec[]>;
  probe?: (model: ModelSpec) => Promise<ProbeResult>;
}

class FakeSource implements Source {
  readonly id: string;
  readonly probeCalls: ModelSpec[] = [];
  listCalls = 0;
  readonly #models: ModelSpec[];
  readonly #listModels: (() => Promise<ModelSpec[]>) | undefined;
  readonly #probe: ((model: ModelSpec) => Promise<ProbeResult>) | undefined;

  constructor(options: FakeSourceOptions) {
    this.id = options.id;
    this.#models = options.models ?? [spec(options.id, "basic")];
    this.#listModels = options.listModels;
    this.#probe = options.probe;
  }

  listModels(): Promise<ModelSpec[]> {
    this.listCalls += 1;
    return this.#listModels === undefined ? Promise.resolve(this.#models) : this.#listModels();
  }

  probe(model: ModelSpec): Promise<ProbeResult> {
    this.probeCalls.push(model);
    return this.#probe === undefined ? Promise.resolve(okProbe()) : this.#probe(model);
  }

  stream(_req: { model: ModelSpec; request: IRRequest }): Promise<ReadableStream<IRChunk>> {
    return Promise.reject(new Error("FakeSource.stream is not used in monitor tests"));
  }
}

function makeScheduler(
  options: Partial<ConstructorParameters<typeof ProbeScheduler>[0]> & {
    store: MetricsStore;
    clock: FakeClock;
  },
): { scheduler: ProbeScheduler; warns: string[] } {
  const { logger, warns } = testLogger();
  const scheduler = new ProbeScheduler({
    rng: () => 0,
    probeEveryMs: 10_000,
    jitterMs: 0,
    staggerMs: 0,
    ...options,
    logger,
  });
  cleanups.push(() => scheduler.close());
  return { scheduler, warns };
}

describe("ProbeScheduler — cadence", () => {
  it("staggers the first cycle per source and keeps a steady cadence", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const a = new FakeSource({ id: "a" });
    const b = new FakeSource({ id: "b" });
    const { scheduler } = makeScheduler({ store, clock, staggerMs: 500 });

    scheduler.registerSources([a, b]).start();
    expect(scheduler.pendingTimerCount).toBe(2);

    const t0 = clock.now();
    expect(clock.pending().map((timer) => timer.at - t0)).toEqual([0, 500]);

    clock.advanceTo(t0);
    await flush();
    expect(a.probeCalls).toHaveLength(1);
    expect(b.probeCalls).toHaveLength(0);

    clock.advanceTo(t0 + 500);
    await flush();
    expect(b.probeCalls).toHaveLength(1);

    // Next ticks: base cadence from each first fire.
    expect(clock.pending().map((timer) => timer.at - t0)).toEqual([10_000, 10_500]);
  });

  it("adds rng-scaled jitter within the configured bound", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const a = new FakeSource({ id: "a" });
    const b = new FakeSource({ id: "b" });
    const { scheduler } = makeScheduler({
      store,
      clock,
      staggerMs: 500,
      jitterMs: 1_000,
      rng: () => 0.5,
    });

    scheduler.registerSources([a, b]).start();
    const t0 = clock.now();
    // stagger (0, 500) + 0.5 * jitter (500 each)
    expect(clock.pending().map((timer) => timer.at - t0)).toEqual([500, 1_000]);

    clock.advanceTo(t0 + 500);
    await flush();
    // next tick = fire time + cadence + jitter
    expect(clock.pending().map((timer) => timer.at - t0)).toEqual([1_000, 11_000]);
  });

  it("schedules sources registered after start", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const { scheduler } = makeScheduler({ store, clock });

    scheduler.start();
    expect(scheduler.pendingTimerCount).toBe(0);

    const source = new FakeSource({ id: "late" });
    scheduler.registerSources([source]);
    expect(scheduler.pendingTimerCount).toBe(1);

    clock.advanceTo(clock.now());
    await flush();
    expect(source.probeCalls).toHaveLength(1);
  });
});

describe("ProbeScheduler — overlap guards", () => {
  it("skips a tick while the previous cycle is still running", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    let release!: (result: ProbeResult) => void;
    const gate = new Promise<ProbeResult>((resolve) => {
      release = resolve;
    });
    const a = new FakeSource({ id: "a", probe: () => gate });
    const { scheduler, warns } = makeScheduler({ store, clock });

    scheduler.registerSources([a]).start();
    clock.advanceTo(clock.now());
    await flush();
    expect(a.probeCalls).toHaveLength(1);

    clock.advanceTo(clock.now() + 10_000);
    await flush();
    expect(a.probeCalls).toHaveLength(1);
    expect(warns.some((line) => line.includes("still running"))).toBe(true);
    expect(scheduler.pendingTimerCount).toBe(1);

    release(okProbe());
    await flush();
    // The next tick runs a fresh cycle once the gate resolved.
    clock.advanceTo(clock.now() + 10_000);
    await flush();
    expect(a.probeCalls).toHaveLength(2);
  });

  it("honors maxConcurrentProbes across sources", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    let release!: (result: ProbeResult) => void;
    const gate = new Promise<ProbeResult>((resolve) => {
      release = resolve;
    });
    const a = new FakeSource({ id: "a", probe: () => gate });
    const b = new FakeSource({ id: "b", probe: () => gate });
    const { scheduler, warns } = makeScheduler({ store, clock, maxConcurrentProbes: 1 });

    scheduler.registerSources([a, b]).start();
    clock.advanceTo(clock.now()); // both timers are due at once
    await flush();

    expect(a.probeCalls).toHaveLength(1);
    expect(b.probeCalls).toHaveLength(0);
    expect(warns.some((line) => line.includes("max concurrent"))).toBe(true);

    release(okProbe());
    await flush();
  });
});

describe("ProbeScheduler — recording", () => {
  it("classifies results, writes them to the store and fires onProbe", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const health = new HealthTracker({ store, clock, cooldownMs: 1_000 });
    const events: ProbeEvent[] = [];
    const source = new FakeSource({
      id: "zai",
      models: [spec("zai", "glm-4.5-flash"), spec("zai", "glm-4.7-flash")],
      probe: async (model) =>
        model.sourceModelId === "glm-4.7-flash"
          ? {
              ok: false,
              latencyMs: 900,
              error: "The service may be temporarily overloaded",
              at: new Date().toISOString(),
            }
          : okProbe(10),
    });
    const { scheduler } = makeScheduler({
      store,
      health,
      clock,
      onProbe: (event) => events.push(event),
    });

    scheduler.registerSources([source]).start();
    clock.advanceTo(clock.now());
    await flush();

    expect(events).toHaveLength(2);
    expect(events[0]?.probe.ok).toBe(true);
    expect(events[0]?.errorKind).toBeUndefined();
    expect(events[1]?.errorKind).toBe("capacity");

    const good = store.getStats("zai", "zai/glm-4.5-flash", 60_000);
    expect(good.probes).toBe(1);
    expect(good.probeSuccessRate).toBe(1);

    const flappy = store.getStats("zai", "zai/glm-4.7-flash", 60_000);
    expect(flappy.probes).toBe(1);
    expect(flappy.probeSuccessRate).toBe(0);
    expect(flappy.lastErrorKind).toBe("capacity");

    // The attached tracker (single write path) fed the breaker too.
    expect(health.state("zai", "zai/glm-4.7-flash")).toBe("cooling");
    expect(health.isRoutable("zai", "zai/glm-4.7-flash")).toBe(false);
    expect(health.state("zai", "zai/glm-4.5-flash")).toBe("healthy");
  });

  it("writes directly to the store when no tracker is attached", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const source = new FakeSource({ id: "a" });
    const { scheduler } = makeScheduler({ store, clock });

    scheduler.registerSources([source]).start();
    clock.advanceTo(clock.now());
    await flush();

    expect(store.probeRunsFor("a", "a/basic")).toHaveLength(1);
  });

  it("falls back to the last-good model list when listing fails", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    let fail = false;
    const source = new FakeSource({
      id: "a",
      listModels: async () => {
        if (fail) throw new Error("catalog fetch failed");
        return [spec("a", "basic")];
      },
    });
    const { scheduler, warns } = makeScheduler({ store, clock });

    scheduler.registerSources([source]).start();
    clock.advanceTo(clock.now());
    await flush();
    expect(source.probeCalls).toHaveLength(1);

    fail = true;
    clock.advanceTo(clock.now() + 10_000);
    await flush();
    expect(source.probeCalls).toHaveLength(2); // cached list probed again
    expect(warns.some((line) => line.includes("failed to list models"))).toBe(false);
  });

  it("skips the cycle when listing fails and there is no cached list", async () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const source = new FakeSource({
      id: "a",
      listModels: async () => {
        throw new Error("catalog fetch failed");
      },
    });
    const { scheduler, warns } = makeScheduler({ store, clock });

    scheduler.registerSources([source]).start();
    clock.advanceTo(clock.now());
    await flush();

    expect(source.probeCalls).toHaveLength(0);
    expect(warns.some((line) => line.includes("failed to list models"))).toBe(true);
  });
});

describe("ProbeScheduler — lifecycle", () => {
  it("stop clears timers; start resumes; close is permanent", () => {
    const store = makeStore();
    const clock = new FakeClock(Date.now());
    const { scheduler } = makeScheduler({ store, clock });
    scheduler.registerSources([new FakeSource({ id: "a" })]);

    scheduler.start();
    expect(scheduler.pendingTimerCount).toBe(1);

    scheduler.stop();
    expect(scheduler.pendingTimerCount).toBe(0);
    expect(clock.pending()).toEqual([]);

    scheduler.start(); // stop is not close
    expect(scheduler.pendingTimerCount).toBe(1);

    scheduler.close();
    expect(scheduler.pendingTimerCount).toBe(0);
    expect(() => scheduler.start()).toThrow(/closed/);
  });

  it("validates cadence options", () => {
    const store = makeStore();
    expect(() => new ProbeScheduler({ store, probeEveryMs: 0 })).toThrow(/probeEveryMs/);
    expect(() => new ProbeScheduler({ store, probeEveryMs: 1.5 })).toThrow(/probeEveryMs/);
    expect(() => new ProbeScheduler({ store, jitterMs: -1 })).toThrow(/jitterMs/);
    expect(() => new ProbeScheduler({ store, jitterMs: 0.5 })).toThrow(/jitterMs/);
  });
});
