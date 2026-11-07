/**
 * Deterministic, OpenAI-compatible mock provider over raw `node:http`.
 *
 * Scenario selection (highest priority first):
 * 1. the `x-mock-scenario` request header,
 * 2. the `scenario` option given to `createMockApp`/`startMockProvider`,
 * 3. the `MOCK_SCENARIO` env var,
 * 4. `"echo"`.
 */
import http from "node:http";
import type { ReadableStream } from "node:stream/web";
import {
  UpstreamError,
  ValidationError,
  irChunkToOpenAIChunk,
  makeErrorBody,
  openAIRequestToIR,
  type IRChunk,
  type IRRequest,
} from "@airoute/core";
import {
  MOCK_SCENARIOS,
  MOCK_TIMEOUT_DELAY_MS,
  createMockEngine,
  normalizeScenario,
  type MockEngine,
} from "./engine.js";
import { MOCK_MODEL_ID } from "./source.js";

export { MOCK_SCENARIOS, MOCK_TIMEOUT_DELAY_MS } from "./engine.js";
export const MOCK_SCENARIO_HEADER = "x-mock-scenario";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface MockAppOptions {
  scenario?: string;
}

/** One engine per scenario per app, so e.g. the 429-storm counter persists. */
export function createMockApp(options: MockAppOptions = {}): http.RequestListener {
  const engines = new Map<string, MockEngine>();
  const engineFor = (scenario: string): MockEngine => {
    let engine = engines.get(scenario);
    if (!engine) {
      engine = createMockEngine({ scenario });
      engines.set(scenario, engine);
    }
    return engine;
  };
  const fallbackScenario = () =>
    options.scenario ?? normalizeScenario(process.env["MOCK_SCENARIO"]);

  return (request, response) => {
    void handle(request, response).catch((err: unknown) => {
      respondError(response, err);
    });
  };

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method ?? "GET";

    if (path === "/healthz" && method === "GET") {
      sendJson(response, 200, { ok: true, provider: "mock-provider", scenarios: MOCK_SCENARIOS });
      return;
    }
    if (path === "/v1/models" && method === "GET") {
      sendJson(response, 200, {
        object: "list",
        data: [{ id: MOCK_MODEL_ID, object: "model", created: 0, owned_by: "mock-provider", free: true }],
      });
      return;
    }
    if (path === "/v1/chat/completions" && method === "POST") {
      await chatCompletion(request, response);
      return;
    }
    sendJson(response, 404, makeErrorBody(`mock provider: no route for ${method} ${path}`, 404, "not_found"));
  }

  async function chatCompletion(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    if (rawBody === null) {
      sendJson(response, 413, makeErrorBody("request body too large", 413, "body_too_large"));
      return;
    }
    if (rawBody.length === 0) {
      sendJson(response, 400, makeErrorBody("request body is empty", 400, "empty_body"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendJson(response, 400, makeErrorBody("request body is not valid JSON", 400, "bad_json"));
      return;
    }
    const irRequest = openAIRequestToIR(parsed);

    const header = request.headers[MOCK_SCENARIO_HEADER];
    const headerScenario = Array.isArray(header) ? header[0] : header;
    const scenario =
      typeof headerScenario === "string" && headerScenario.length > 0
        ? normalizeScenario(headerScenario)
        : fallbackScenario();
    const engine = engineFor(scenario);

    let upstream: ReadableStream<IRChunk>;
    try {
      upstream = await engine.stream(irRequest);
      if (irRequest.stream) {
        await streamSse(upstream, response, irRequest);
      } else {
        await bufferJson(upstream, response, irRequest);
      }
    } catch (err) {
      respondError(response, err);
    }
  }

  /** Streams SSE; the `drop-mid-stream`/`timeout` scenarios destroy the socket instead of ending cleanly. */
  async function streamSse(
    upstream: ReadableStream<IRChunk>,
    response: http.ServerResponse,
    irRequest: IRRequest,
  ): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    let sawFinish = false;
    for await (const chunk of iterateEngineStream(upstream)) {
      if (chunk.finishReason != null) sawFinish = true;
      const wire = irChunkToOpenAIChunk(chunk, irRequest.model);
      response.write(`data: ${JSON.stringify(wire)}\n\n`);
    }
    if (sawFinish) {
      response.write("data: [DONE]\n\n");
      response.end();
    } else {
      // Wire-form of "drop-mid-stream": end mid-stream, no finish, no [DONE].
      response.socket?.destroy();
    }
  }

  async function bufferJson(
    upstream: ReadableStream<IRChunk>,
    response: http.ServerResponse,
    irRequest: IRRequest,
  ): Promise<void> {
    const pieces: string[] = [];
    let finishReason: "stop" | "length" | "tool_calls" = "stop";
    for await (const chunk of iterateEngineStream(upstream)) {
      if (chunk.content !== undefined) pieces.push(chunk.content);
      if (chunk.finishReason != null) finishReason = chunk.finishReason;
    }
    sendJson(response, 200, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: irRequest.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: pieces.join("") },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

async function* iterateEngineStream(stream: ReadableStream<IRChunk>): AsyncGenerator<IRChunk> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function respondError(response: http.ServerResponse, err: unknown): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  if (err instanceof ValidationError) {
    sendJson(response, err.status, makeErrorBody(err.message, err.status, "invalid_request"));
    return;
  }
  const status = err instanceof UpstreamError ? err.status : 500;
  const code = err instanceof UpstreamError && err.code !== undefined ? err.code : "mock_error";
  sendJson(response, status, makeErrorBody(messageOf(err), status, code));
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : "mock provider error";
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = raw as Buffer;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/* -------------------------------------------------------------------------- */
/* Server lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export interface StartedMockProvider {
  server: http.Server;
  host: string;
  port: number;
  /** `http://127.0.0.1:<port>` */
  url: string;
  close(): Promise<void>;
}

export interface StartMockProviderOptions {
  port?: number;
  scenario?: string;
  host?: string;
}

/**
 * Start the mock provider. `startMockProvider()` picks an ephemeral port;
 * `startMockProvider(3000)` or `startMockProvider({ port: 3000 })` binds a
 * fixed one.
 */
export async function startMockProvider(
  portOrOptions?: number | StartMockProviderOptions,
): Promise<StartedMockProvider> {
  const options: StartMockProviderOptions =
    typeof portOrOptions === "number" ? { port: portOrOptions } : (portOrOptions ?? {});
  const app = createMockApp({ scenario: options.scenario });
  const server = http.createServer(app);
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : requestedPort;

  return {
    server,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
