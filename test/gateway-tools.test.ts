/**
 * Tool-calling through the gateway, end to end: a fake source streams IR
 * tool-call deltas; the non-stream path buffers them into
 * `message.tool_calls` and the streaming path forwards `delta.tool_calls`.
 * Loopback HTTP, offline.
 */
import { type AddressInfo } from "node:net";
import type { ReadableStream } from "node:stream/web";
import { createSourceRegistry, type IRChunk, type ModelSpec, type Source } from "@airoute/core";
import { startGateway, type GatewayHandle } from "@airoute/gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestLogger } from "./helpers/test-logger.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function spec(sourceId: string, name: string): ModelSpec {
  return {
    id: `${sourceId}/${name}`,
    sourceId,
    sourceModelId: name,
    label: name,
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    free: true,
    aliases: [],
  };
}

const TOOL_CALL = { id: "call_weather", name: "get_weather", arguments: "{\"location\":\"Paris\"}" } as const;

const toolChunks: IRChunk[] = [
  { index: 0, role: "assistant" },
  { index: 1, toolCalls: [{ index: 0, id: TOOL_CALL.id, name: TOOL_CALL.name, arguments: "{\"location\":" }] },
  { index: 2, toolCalls: [{ index: 0, arguments: "\"Paris\"}" }] },
  { index: 3, finishReason: "tool_calls", done: true },
];

const plainChunks: IRChunk[] = [
  { index: 0, role: "assistant" },
  { index: 1, content: "sunny" },
  { index: 2, finishReason: "stop", done: true },
];

function streamOf(chunks: IRChunk[]): ReadableStream<IRChunk> {
  return new ReadableStream<IRChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

class FakeSource implements Source {
  readonly id = "fake";
  listModels(): Promise<ModelSpec[]> {
    return Promise.resolve([spec("fake", "basic")]);
  }
  stream(_req: { model: ModelSpec }): Promise<ReadableStream<IRChunk>> {
    return Promise.resolve(streamOf(toolChunks));
  }
  probe(): Promise<{ ok: boolean; at: string }> {
    return Promise.resolve({ ok: true, at: new Date().toISOString() });
  }
}

let gateway: GatewayHandle | undefined;
let baseUrl: string;
let source: FakeSource;

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
  },
} as const;

const chatBody = {
  model: "free-fake",
  messages: [{ role: "user", content: "weather in Paris?" }],
  tools: [weatherTool],
};

beforeAll(async () => {
  const logger = createTestLogger().logger;
  const registry = createSourceRegistry();
  source = new FakeSource();
  registry.register(source);
  gateway = await startGateway({
    registry,
    aliasMap: { "free-fake": ["fake/basic"] },
    installShutdownHandlers: false,
    logger,
    port: 0,
  });
  const address = gateway.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await gateway?.stop();
  gateway = undefined;
});

async function postChat(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("gateway — non-stream tool calling", () => {
  it("buffers tool calls into message.tool_calls with content: null and finish_reason tool_calls", async () => {
    const res = await postChat(chatBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> };
    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.role).toBe("assistant");
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([
      { id: TOOL_CALL.id, type: "function", function: { name: TOOL_CALL.name, arguments: TOOL_CALL.arguments } },
    ]);
  });

  it("keeps plain (no-tool) completions in the current { role, content } shape", async () => {
    const registry = createSourceRegistry();
    registry.register({
      id: "plain",
      listModels: () => Promise.resolve([spec("plain", "basic")]),
      stream: () => Promise.resolve(streamOf(plainChunks)),
      probe: () => Promise.resolve({ ok: true, at: new Date().toISOString() }),
    });
    const logger = createTestLogger().logger;
    const plainGateway = await startGateway({
      registry,
      aliasMap: { "free-plain": ["plain/basic"] },
      installShutdownHandlers: false,
      logger,
      port: 0,
    });
    const address = plainGateway.server.address() as AddressInfo;
    const plainUrl = `http://127.0.0.1:${address.port}`;
    try {
      const res = await fetch(`${plainUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "free-plain", messages: chatBody.messages }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // exactly the previous shape: message is { role, content } only
      expect(body.choices[0]!.message).toEqual({ role: "assistant", content: "sunny" });
      expect(body.choices[0]!.finish_reason).toBe("stop");
    } finally {
      void plainGateway.stop();
    }
  });
});

describe("gateway — streaming tool calling", () => {
  it("emits at least one SSE delta.tool_calls and a tool_calls finish chunk", async () => {
    const res = await postChat({ ...chatBody, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readSseFrames(res);
    const dataFrames = frames.filter((f): f is { kind: "data"; value: Record<string, unknown> } => f.kind === "data");
    const withTools = dataFrames.filter((f) => {
      const choices = f.value["choices"] as Array<{ delta: Record<string, unknown> }> | undefined;
      return choices?.[0]?.delta?.tool_calls !== undefined;
    });
    expect(withTools.length).toBeGreaterThanOrEqual(1);
    expect((withTools[0]!.value["choices"] as Array<{ delta: { tool_calls: unknown[] } }>)[0]!.delta.tool_calls).toEqual([
      { index: 0, type: "function", id: TOOL_CALL.id, function: { name: TOOL_CALL.name, arguments: "{\"location\":" } },
    ]);

    const last = dataFrames[dataFrames.length - 1]!;
    expect((last.value["choices"] as Array<{ finish_reason: string }>)[0]!.finish_reason).toBe("tool_calls");
    expect(frames[frames.length - 1]).toEqual({ kind: "done" });
  });
});

describe("gateway — tool-call follow-up requests", () => {
  it("accepts a conversation containing assistant tool_calls + a tool result message", async () => {
    const followUp = {
      model: "free-fake",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: TOOL_CALL.id, type: "function", function: { name: TOOL_CALL.name, arguments: TOOL_CALL.arguments } },
          ],
        },
        { role: "tool", tool_call_id: TOOL_CALL.id, content: "18°C, light rain" },
      ],
      tools: [weatherTool],
    };
    const res = await postChat(followUp);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: Record<string, unknown> }> };
    expect(body.choices[0]!.message.tool_calls).toHaveLength(1);
  });
});
