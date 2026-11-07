/**
 * Mock `Source` implementation for direct registry injection in tests and
 * local dev. It feeds off the same deterministic engine as the HTTP mock
 * provider, so in-process tests and wire tests share semantics.
 */
import type { ReadableStream } from "node:stream/web";
import {
  type IRChunk,
  type IRRequest,
  type ModelSpec,
  type ProbeResult,
  type Source,
} from "@airoute/core";
import { createMockEngine, normalizeScenario, type MockEngine, type MockScenario } from "./engine.js";

export const DEFAULT_MOCK_SOURCE_ID = "mock";
/**
 * Provider-visible model id served by both the HTTP mock provider and the
 * mock source. The gateway-level spec id is "<sourceId>/mock/basic"; with the
 * default source id this is "mock/mock/basic".
 */
export const MOCK_MODEL_ID = "mock/basic";
export const MOCK_MODEL_CONTEXT_WINDOW = 8192;

export interface MockSourceOptions {
  /** Source id; default "mock". Determines `ModelSpec.id` ("<id>/mock/basic"). */
  id?: string;
  /** Scenario name (see `MOCK_SCENARIOS`); default "echo". */
  scenario?: string;
}

export class MockSource implements Source {
  readonly id: string;
  readonly #engine: MockEngine;
  readonly #scenario: MockScenario;

  constructor(options: MockSourceOptions = {}) {
    this.id = options.id ?? DEFAULT_MOCK_SOURCE_ID;
    this.#scenario = normalizeScenario(options.scenario);
    this.#engine = createMockEngine({ scenario: this.#scenario });
  }

  get scenario(): MockScenario {
    return this.#scenario;
  }

  async listModels(): Promise<ModelSpec[]> {
    return [this.modelSpec()];
  }

  modelSpec(): ModelSpec {
    return {
      id: `${this.id}/${MOCK_MODEL_ID}`,
      sourceId: this.id,
      sourceModelId: MOCK_MODEL_ID,
      label: "Mock Basic (deterministic test model)",
      contextWindow: MOCK_MODEL_CONTEXT_WINDOW,
      caps: { tools: true, vision: false, reasoning: false },
      free: true,
      aliases: ["mock-basic"],
      meta: { scenario: this.#scenario, provider: "mock-provider" },
    };
  }

  stream(req: { model: ModelSpec; request: IRRequest }): Promise<ReadableStream<IRChunk>> {
    return this.#engine.stream(req.request);
  }

  async probe(model: ModelSpec): Promise<ProbeResult> {
    const at = new Date().toISOString();
    if (model.sourceId !== this.id) {
      return { ok: false, error: `model ${model.id} is not owned by source ${this.id}`, at };
    }
    if (this.#scenario === "bad-key") {
      return { ok: false, error: "mock upstream: invalid api key", at };
    }
    const start = performance.now();
    return { ok: true, latencyMs: Math.max(1, Math.round(performance.now() - start)), at };
  }
}

/** Factory for the mock source; pass `{ id, scenario }` to customize. */
export function createMockSource(options: MockSourceOptions = {}): MockSource {
  return new MockSource(options);
}
