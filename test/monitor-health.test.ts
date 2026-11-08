/**
 * HealthTracker (circuit breaker) tests — deterministic clock, in-memory store.
 * Verifies the transition policy including the live-observed ZAI capacity
 * flap and auth/quota handling.
 */
import {
  createInMemoryStore,
  HealthTracker,
  type MetricsStore,
  type StateChange,
} from "@airoute/monitor";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "./helpers/fake-clock.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function setup(options: Partial<ConstructorParameters<typeof HealthTracker>[0]> = {}) {
  const store = createInMemoryStore();
  const clock = new FakeClock(1_000_000);
  const changes: StateChange[] = [];
  const health = new HealthTracker({
    store,
    clock,
    onStateChange: (change) => changes.push(change),
    ...options,
  });
  cleanups.push(() => store.close());
  return { store, clock, health, changes };
}

const pair = { sourceId: "zai", modelId: "zai/glm-4.5-flash" };

describe("HealthTracker — probe failures", () => {
  it("takes a model down after the probe failure streak and persists it", () => {
    const { store, health, changes } = setup();
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");

    for (let i = 0; i < 2; i++) {
      health.recordProbe({ ...pair, ok: false, errorKind: "server" });
      expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
    }
    health.recordProbe({ ...pair, ok: false, errorKind: "server" });

    expect(health.state(pair.sourceId, pair.modelId)).toBe("down");
    expect(health.isRoutable(pair.sourceId, pair.modelId)).toBe(false);
    expect(changes.map((c) => c.reason)).toContain("probe_failure_streak");
    expect(store.getBreakerState(pair.sourceId, pair.modelId)?.breaker).toBe("down");
  });

  it("restores persisted breaker state across tracker instances", () => {
    const store = createInMemoryStore();
    cleanups.push(() => store.close());
    const clock = new FakeClock(1_000_000);
    const first = new HealthTracker({ store, clock });
    for (let i = 0; i < 3; i++) {
      first.recordProbe({ ...pair, ok: false, errorKind: "server" });
    }
    expect(first.state(pair.sourceId, pair.modelId)).toBe("down");

    const second = new HealthTracker({ store, clock });
    expect(second.state(pair.sourceId, pair.modelId)).toBe("down");
    expect(second.isRoutable(pair.sourceId, pair.modelId)).toBe(false);
  });

  it("heals a down model when a probe succeeds after the cooldown", () => {
    const { health, changes, clock } = setup({ cooldownMs: 1_000 });
    for (let i = 0; i < 3; i++) {
      health.recordProbe({ ...pair, ok: false, errorKind: "server" });
    }
    expect(health.state(pair.sourceId, pair.modelId)).toBe("down");

    // Too early: a success inside the down cooldown is deliberately ignored.
    health.recordProbe({ ...pair, ok: true, latencyMs: 120 });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("down");

    clock.advance(1_001);
    health.recordProbe({ ...pair, ok: true, latencyMs: 120 });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
    expect(changes.filter((c) => c.reason === "probe_success")).toHaveLength(1);
  });
});

describe("HealthTracker — capacity and auth cooldowns", () => {
  it("cools the ZAI-style capacity flap with an exponential backoff", () => {
    const { clock, health } = setup({ cooldownMs: 1_000 });
    const now = clock.now();

    // A "temporarily overloaded" probe → cooling, routable=false.
    health.recordProbe({
      ...pair,
      ok: false,
      errorKind: "capacity",
      errorDetail: "The service may be temporarily overloaded",
    });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("cooling");
    expect(health.isRoutable(pair.sourceId, pair.modelId)).toBe(false);
    expect(health.cooldownExpiresAt(pair.sourceId, pair.modelId)).toBe(now + 1_000);

    // Cooldown expiry is lazy: the next read heals the state.
    clock.advance(1_000);
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");

    // Second consecutive capacity failure doubles the cooldown.
    health.recordProbe({ ...pair, ok: false, errorKind: "capacity" });
    expect(health.cooldownExpiresAt(pair.sourceId, pair.modelId)).toBe(clock.now() + 2_000);
  });

  it("caps the capacity backoff at maxCooldownMs", () => {
    const { clock, health } = setup({ cooldownMs: 1_000, maxCooldownMs: 5_000 });
    for (let i = 0; i < 4; i++) {
      health.recordProbe({ ...pair, ok: false, errorKind: "capacity" });
      clock.advance(health.cooldownExpiresAt(pair.sourceId, pair.modelId) - clock.now());
    }
    health.recordProbe({ ...pair, ok: false, errorKind: "capacity" });
    const remaining = health.cooldownExpiresAt(pair.sourceId, pair.modelId) - clock.now();
    expect(remaining).toBeLessThanOrEqual(5_000);
  });

  it("applies the long flat auth cooldown and does not passively recover", () => {
    const { clock, health, changes } = setup();
    health.recordProbe({ ...pair, ok: false, errorKind: "auth" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("cooling");
    expect(health.cooldownExpiresAt(pair.sourceId, pair.modelId) - clock.now()).toBe(1_800_000);
    expect(changes.map((c) => c.reason)).toContain("auth_cooling");

    // Passive successes must not clear a cooling state.
    for (let i = 0; i < 5; i++) health.recordRequest({ ...pair, outcome: "ok" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("cooling");
  });
});

describe("HealthTracker — passive request signals", () => {
  it("degrades after the request failure threshold and recovers passively", () => {
    const { health } = setup();
    for (let i = 0; i < 3; i++) {
      health.recordRequest({ ...pair, outcome: "server" });
    }
    expect(health.state(pair.sourceId, pair.modelId)).toBe("degraded");
    // Degraded is still routable (the ranker penalizes it).
    expect(health.isRoutable(pair.sourceId, pair.modelId)).toBe(true);

    // Two oks are not enough; the third recovers.
    health.recordRequest({ ...pair, outcome: "ok" });
    health.recordRequest({ ...pair, outcome: "ok" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("degraded");
    health.recordRequest({ ...pair, outcome: "ok" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
  });

  it("cools immediately on a capacity outcome", () => {
    const { health, clock } = setup({ cooldownMs: 1_000 });
    health.recordRequest({ ...pair, outcome: "capacity" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("cooling");
    clock.advance(1_000);
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
  });

  it("treats client drops as neutral", () => {
    const { health } = setup();
    for (let i = 0; i < 10; i++) health.recordRequest({ ...pair, outcome: "drop" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
  });

  it("does not degrade on failures spread outside the window", () => {
    const { health, clock } = setup({ requestFailureWindowMs: 5_000, requestFailureThreshold: 2 });
    health.recordRequest({ ...pair, outcome: "server" });
    clock.advance(5_001);
    health.recordRequest({ ...pair, outcome: "server" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
  });
});

describe("HealthTracker — operator actions and diagnostics", () => {
  it("manualReset clears a down model", () => {
    const { health } = setup();
    for (let i = 0; i < 3; i++) health.recordProbe({ ...pair, ok: false, errorKind: "server" });
    expect(health.state(pair.sourceId, pair.modelId)).toBe("down");

    health.manualReset(pair.sourceId, pair.modelId);
    expect(health.state(pair.sourceId, pair.modelId)).toBe("healthy");
    expect(health.cooldownExpiresAt(pair.sourceId, pair.modelId)).toBe(0);
  });

  it("snapshot lists tracked pairs with their state", () => {
    const { health } = setup();
    health.recordProbe({ ...pair, ok: false, errorKind: "capacity" });
    health.recordProbe({
      sourceId: "openrouter",
      modelId: "openrouter/openrouter/free",
      ok: true,
    });
    const rows = health.snapshot();
    expect(rows).toHaveLength(2);
    const zaiRow = rows.find((row) => row.sourceId === "zai");
    expect(zaiRow?.state).toBe("cooling");
  });
});
