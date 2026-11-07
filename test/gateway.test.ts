import { type AddressInfo } from "node:net";
import {
  createSourceRegistry,
  type ModelSpec,
  type Source,
  type SourceRegistry,
} from "@airoute/core";
import { startGateway, type GatewayHandle } from "@airoute/gateway";
import { createMockSource, MOCK_MODEL_ID } from "@airoute/mock-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let gateway: GatewayHandle | undefined;
let baseUrl: string;

/**
 * A source that (deliberately, at runtime only) advertises a non-free model —
 * `ModelSpec.free` is a literal `true` at build time, so this fakes the one
 * shape the type system cannot express, to prove the gateway still enforces
 * free-only with 403.
 */
function paidSource(registry: SourceRegistry): void {
  const paidSpec = {
    id: "paid/paid-fast",
    sourceId: "paid",
    sourceModelId: "paid-fast",
    label: "Paid Fast (not free)",
    contextWindow: 32_000,
    caps: { tools: true, vision: true, reasoning: false },
    free: false,
    aliases: [],
  } as unknown as ModelSpec;
  const source = {
    id: "paid",
    listModels: async () => [paidSpec],
    stream: async () => {
      throw new Error("paid source must never be routed");
    },
    probe: async () => ({ ok: true, at: new Date().toISOString() }),
  } satisfies Source;

  registry.register(source);
}

beforeAll(async () => {
  const registry = createSourceRegistry();
  // default scenario (echo)
  registry.register(createMockSource({ id: "mock" }));
  // dedicated scenarios
  registry.register(createMockSource({ id: "mock-drop", scenario: "drop-mid-stream" }));
  registry.register(createMockSource({ id: "mock-storm", scenario: "429-storm" }));
  // runtime invariant violation: a paid model must be refused with 403
  paidSource(registry);

  gateway = await startGateway({
    registry,
    aliasMap: { "free-mock": ["mock/mock/basic"] },
    installShutdownHandlers: false,
    port: 0,
  });
  const address = gateway.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await gateway?.stop();
  gateway = undefined;
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function postChat(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

type SseFrame = { kind: "data"; value: Record<string, unknown> } | { kind: "done" };

async function readSseFrames(response: Response): Promise<SseFrame[]> {
  const stream = response.body;
  if (stream === null) throw new Error("response has no body");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine === undefined) continue;
        const payload = dataLine.slice("data: ".length).trim();
        frames.push(payload === "[DONE]" ? { kind: "done" } : { kind: "data", value: JSON.parse(payload) });
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return frames;
}

function deltaText(frame: SseFrame | undefined): string {
  if (frame === undefined || frame.kind !== "data") return "";
  const choice = (frame.value["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
  const delta = choice?.["delta"] as Record<string, unknown> | undefined;
  const content = delta?.["content"];
  return typeof content === "string" ? content : "";
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("gateway", () => {
  it("GET /healthz reports ok + per-source model counts", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      version: string;
      sources: Array<{ id: string; modelCount: number }>;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.sources).toHaveLength(4);
    const mock = body.sources.find((entry) => entry.id === "mock");
    expect(mock).toEqual({ id: "mock", modelCount: 1 });
  });

  it("GET /v1/models includes the mock model as '<sourceId>/mock/basic'", async () => {
    const response = await fetch(`${baseUrl}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe("list");
    const mock = body.data.find((entry) => entry["id"] === `mock/${MOCK_MODEL_ID}`);
    expect(mock).toBeDefined();
    expect(mock?.["object"]).toBe("model");
    expect(mock?.["owned_by"]).toBe("mock");
    expect(mock?.["free"]).toBe(true);
    expect(mock?.["context_window"]).toBe(8192);
  });

  it("POST non-stream echoes the last user message over OpenAI wire", async () => {
    const response = await postChat({
      model: "mock/mock/basic",
      stream: false,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello world" },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      model: string;
      choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("mock/mock/basic");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toBe("ECHO: hello world");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  it("POST stream delivers ordered SSE deltas then [DONE]", async () => {
    const response = await postChat({
      model: "mock/mock/basic",
      stream: true,
      messages: [{ role: "user", content: "hello world" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readSseFrames(response);
    expect(frames.at(-1)).toEqual({ kind: "done" });
    const data = frames.filter((frame): frame is Extract<SseFrame, { kind: "data" }> => frame.kind === "data");

    // First chunk carries the role.
    const first = data.at(0);
    expect(deltaChoice(first)?.delta.role).toBe("assistant");
    // Deltas arrive in order and concatenate to the full echo text.
    const text = data.map(deltaText).join("");
    expect(text).toBe("ECHO: hello world");
    // Terminal chunk has finish_reason stop.
    const lastData = data.at(-1);
    const lastChoice = deltaChoice(lastData);
    expect(lastChoice?.finish_reason).toBe("stop");
    // Every frame is a well-formed OpenAI chunk.
    for (const frame of data) {
      expect(frame.value["object"]).toBe("chat.completion.chunk");
      expect(frame.value["model"]).toBe("mock/mock/basic");
    }
  });

  it("drop-mid-stream is repaired with a synthesized 'stop' chunk", async () => {
    const response = await postChat({
      model: "mock-drop/mock/basic",
      stream: true,
      messages: [{ role: "user", content: "will be cut" }],
    });
    expect(response.status).toBe(200);
    const frames = await readSseFrames(response);
    expect(frames.at(-1)).toEqual({ kind: "done" });

    const data = frames.filter((frame): frame is Extract<SseFrame, { kind: "data" }> => frame.kind === "data");
    const lastData = data.at(-1);
    const choice = deltaChoice(lastData);
    expect(choice?.finish_reason).toBe("stop");
    expect(choice?.delta).toEqual({});
  });

  it("429-storm passes through 429 with an OpenAI error envelope", async () => {
    const response = await postChat({
      model: "mock-storm/mock/basic",
      messages: [{ role: "user", content: "anything" }],
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as {
      error: { message: string; type: string; code: string | null };
    };
    expect(body.error.message).toBeTruthy();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("rejects non-free specs with 403 even when injected at runtime", async () => {
    const response = await postChat({
      model: "paid/paid-fast",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { message: string; type: string; code: string | null };
    };
    expect(body.error.code).toBe("model_not_free");
    expect(body.error.message).toContain("free model");
  });

  it("unknown models get a helpful 404", async () => {
    const response = await postChat({
      model: "mock/mock/nosuch",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string; type: string; code: string | null } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("mock/mock/nosuch");
  });

  it("gateway-level aliases route via the config bucket", async () => {
    const response = await postChat({
      model: "free-mock",
      messages: [{ role: "user", content: "alias" }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe("free-mock");
    expect(body.choices[0]?.message.content).toBe("ECHO: alias");
  });

  it("malformed request bodies fail with 400 validation errors", async () => {
    const badMessages = await postChat({ model: "mock/mock/basic", messages: [] });
    expect(badMessages.status).toBe(400);
    const missingModel = await postChat({ messages: [{ role: "user", content: "x" }] });
    expect(missingModel.status).toBe(400);
    const badRole = await postChat({
      model: "mock/mock/basic",
      messages: [{ role: "robot", content: "x" }],
    });
    expect(badRole.status).toBe(400);
    const notJson = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(notJson.status).toBe(400);
    const notJsonBody = (await notJson.json()) as { error: { type: string; code: string | null } };
    expect(notJsonBody.error.type).toBe("invalid_request_error");
    expect(notJsonBody.error.code).toBe("bad_json");
  });
});

function deltaChoice(frame: Extract<SseFrame, { kind: "data" }> | undefined) {
  if (frame === undefined) return undefined;
  const choices = frame.value["choices"] as Array<Record<string, unknown>> | undefined;
  return choices?.[0] as
    | { delta: { role?: string; content?: string }; finish_reason: string | null }
    | undefined;
}
