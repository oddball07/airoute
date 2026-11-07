/**
 * AIRoute HTTP gateway.
 *
 * Endpoints (OpenAI-compatible, no auth in Phase 0/1):
 * - `GET /healthz`  — liveness + per-source model counts.
 * - `GET /v1/models` — aggregated free-model catalog.
 * - `POST /v1/chat/completions` — OpenAI wire in, OpenAI wire out (SSE or JSON).
 *
 * Streaming is real SSE: chunks are written/flushed as they arrive from the
 * source, never buffered into a whole response.
 */
import http from "node:http";
import type { ReadableStream } from "node:stream/web";
import {
  AIRROUTE_VERSION,
  UpstreamError,
  ValidationError,
  closestModelIds,
  createLogger,
  irChunkToOpenAIChunk,
  makeErrorBody,
  openAIRequestToIR,
  resolveModelFromSpecs,
  type AliasMap,
  type IRChunk,
  type Logger,
  type ModelSpec,
  type SourceRegistry,
} from "@airoute/core";

/**
 * Upstream timeout window. Non-streaming calls treat it as a whole-request
 * deadline; streaming calls treat it as an idle deadline that resets on every
 * chunk (including the first one, so it doubles as a first-token deadline).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Cap on request bodies; larger uploads get 413. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface GatewayOptions {
  registry: SourceRegistry;
  logger?: Logger;
  /** Config-declared alias buckets, used by `resolveModel`. */
  aliasMap?: AliasMap;
  /** Reported by /healthz; defaults to the core version constant. */
  version?: string;
  /** Upstream idle timeout for streams (reset per chunk); whole-request deadline for non-stream. Default 120 s. */
  requestTimeoutMs?: number;
  /** Request body size cap in bytes. Default 10 MiB. */
  maxBodyBytes?: number;
}

export interface ServeOptions extends GatewayOptions {
  host?: string;
  /** Default 0 (ephemeral port); the CLI passes the configured port. */
  port?: number;
  /** Install SIGINT/SIGTERM/SIGBREAK graceful shutdown. Default true. */
  installShutdownHandlers?: boolean;
}

export interface GatewayHandle {
  server: http.Server;
  host: string;
  port: number;
  version: string;
  /** Close the server (and its sockets); resolves when the close completes. */
  stop(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Server factory                                                             */
/* -------------------------------------------------------------------------- */

export function createGateway(options: GatewayOptions): http.Server {
  const logger = options.logger ?? createLogger({ scope: "airoute:gateway" });
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options, logger).catch((err: unknown) => {
      logger.error("unhandled error while handling request", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!response.headersSent) {
        sendJson(response, 500, makeErrorBody("internal error", 500, "internal_error"));
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.on("clientError", (err, socket) => {
    if (socket.writable && !socket.destroyed) {
      void socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
    logger.debug("client error", { error: err.message });
  });
  return server;
}

export async function startGateway(options: ServeOptions): Promise<GatewayHandle> {
  const logger = options.logger ?? createLogger({ scope: "airoute:gateway" });
  const server = createGateway(options);
  const host = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => resolve());
  });

  const address = server.address();
  const boundPort =
    address !== null && typeof address === "object" ? address.port : listenPort;

  if (options.installShutdownHandlers ?? true) {
    installShutdownHandlers(server, { logger });
  }

  return {
    server,
    host,
    port: boundPort,
    version: options.version ?? AIRROUTE_VERSION,
    stop(): Promise<void> {
      shutdownServer(server);
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      });
    },
  };
}

/** Close the server, dropping idle/keep-alive sockets so it terminates promptly. */
function shutdownServer(server: http.Server): void {
  server.closeAllConnections();
  server.closeIdleConnections();
}

/**
 * Graceful shutdown for SIGINT / SIGTERM / SIGBREAK (Git Bash / *nix /
 * Windows). Returns an uninstaller.
 */
export function installShutdownHandlers(
  server: http.Server,
  options: { logger?: Logger } = {},
): () => void {
  const logger = options.logger ?? createLogger({ scope: "airoute:gateway" });
  // SIGBREAK is the Windows Ctrl+Break/console-close signal. There is no
  // reliable feature check for it (signal names are not properties of
  // `process`), so it is registered unconditionally; platforms without it
  // throw at registration time and the try/catch below then skips it.
  const supported: string[] = ["SIGINT", "SIGTERM", "SIGBREAK"];
  const handlers: Array<[string, () => void]> = [];
  let shuttingDown = false;

  for (const signal of supported) {
    const handler = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`received ${signal}; shutting down gateway`);
      shutdownServer(server);
      // Hard fallback in case a wedged socket keeps the server open.
      const bail = setTimeout(() => process.exit(0), 3000);
      bail.unref();
      server.close(() => {
        logger.info("gateway closed; exiting");
        process.exit(0);
      });
    };
    try {
      process.on(signal as "SIGINT", handler);
      handlers.push([signal, handler]);
    } catch {
      // Signal unsupported on this platform; skip.
    }
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal as "SIGINT", handler);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: GatewayOptions,
  logger: Logger,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method ?? "GET";

  if (path === "/healthz" && method === "GET") return void (await healthz(response, options));
  if (path === "/v1/models" && method === "GET") return void (await listModels(response, options));
  if (path === "/v1/chat/completions") {
    if (method !== "POST") {
      sendJson(response, 405, makeErrorBody("use POST for /v1/chat/completions", 405, "method_not_allowed"));
      return;
    }
    await chatCompletions(request, response, options, logger);
    return;
  }
  if (path === "/" && method === "GET") {
    sendJson(response, 200, {
      name: "airoute",
      version: options.version ?? AIRROUTE_VERSION,
      endpoints: ["/healthz", "/v1/models", "/v1/chat/completions"],
    });
    return;
  }
  sendJson(response, 404, makeErrorBody(`no route for ${method} ${path}`, 404, "not_found"));
}

async function healthz(response: http.ServerResponse, options: GatewayOptions): Promise<void> {
  const sources = await Promise.all(
    options.registry.all().map(async (source) => {
      try {
        const models = await source.listModels();
        return { id: source.id, modelCount: models.length };
      } catch (err) {
        return {
          id: source.id,
          modelCount: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  sendJson(response, 200, {
    ok: true,
    sources,
    version: options.version ?? AIRROUTE_VERSION,
  });
}

async function listModels(response: http.ServerResponse, options: GatewayOptions): Promise<void> {
  const specs = await options.registry.models();
  sendJson(response, 200, {
    object: "list",
    data: specs.map((spec) => ({
      id: spec.id,
      object: "model",
      created: 0,
      owned_by: spec.sourceId,
      label: spec.label,
      context_window: spec.contextWindow,
      free: spec.free as boolean,
      caps: spec.caps,
      aliases: spec.aliases,
    })),
  });
}

/* -------------------------------------------------------------------------- */
/* POST /v1/chat/completions                                                  */
/* -------------------------------------------------------------------------- */

async function chatCompletions(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: GatewayOptions,
  logger: Logger,
): Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rawBody = await readBody(request, maxBodyBytes);
  if (rawBody === null) {
    sendJson(response, 413, makeErrorBody("request body too large", 413, "body_too_large"));
    return;
  }
  let parsed: unknown;
  try {
    parsed = rawBody.length === 0 ? undefined : JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(response, 400, makeErrorBody("request body is not valid JSON", 400, "bad_json"));
    return;
  }
  if (parsed === undefined) {
    sendJson(response, 400, makeErrorBody("request body is empty", 400, "empty_body"));
    return;
  }

  let irRequest;
  try {
    irRequest = openAIRequestToIR(parsed);
  } catch (err) {
    sendJson(
      response,
      400,
      makeErrorBody(
        err instanceof Error ? err.message : "invalid request",
        400,
        "invalid_request",
      ),
    );
    return;
  }

  const specs = await options.registry.models();
  const resolution = resolveModelFromSpecs(specs, irRequest.model, {
    aliasMap: options.aliasMap,
  });
  if (resolution.kind === "unknown") {
    sendUnknownModel(response, irRequest.model, specs);
    return;
  }
  const spec = resolution.spec;

  // Free-only enforcement (runtime check; type system already bans paid specs).
  if (spec.free !== true) {
    sendJson(
      response,
      403,
      makeErrorBody(
        `model "${spec.id}" is not a free model; AIRoute routes free models only`,
        403,
        "model_not_free",
      ),
    );
    return;
  }

  const source = options.registry.get(spec.sourceId);
  if (!source) {
    sendJson(
      response,
      503,
      makeErrorBody(
        `source "${spec.sourceId}" backing model "${spec.id}" is not available`,
        503,
        "source_unavailable",
      ),
    );
    return;
  }

  let upstream: ReadableStream<IRChunk>;
  try {
    upstream = await source.stream({ model: spec, request: irRequest });
  } catch (err) {
    respondUpstreamFailure(response, err, logger, "failed to start upstream stream", {
      source: source.id,
      model: spec.id,
    });
    return;
  }

  const aliasResolution = resolution.kind;
  logger.debug("routing chat completion", {
    source: source.id,
    model: spec.id,
    requested: irRequest.model,
    via: aliasResolution,
    stream: irRequest.stream === true,
  });

  if (irRequest.stream) {
    await streamCompletion(upstream, response, irRequest.model, options.requestTimeoutMs, logger, {
      source: source.id,
      model: spec.id,
    });
  } else {
    await bufferCompletion(upstream, response, irRequest.model, options.requestTimeoutMs, logger, {
      source: source.id,
      model: spec.id,
    });
  }
}

/**
 * Build the unknown-model 404 from the specs the router already resolved —
 * no second catalog fetch.
 */
function sendUnknownModel(
  response: http.ServerResponse,
  requested: string,
  specs: readonly ModelSpec[],
): void {
  const ids = specs.map((spec) => spec.id);
  const suggestions = closestModelIds(requested, ids);
  const hints =
    suggestions.length > 0 ? ` did you mean: ${suggestions.join(", ")}?` : "";
  const available = ids.length > 0 ? ` available: ${ids.join(", ")}` : " (no free models are currently enabled)";
  sendJson(
    response,
    404,
    makeErrorBody(`model "${requested}" not found.${hints}${available}`, 404, "model_not_found"),
  );
}

/* -------------------------------------------------------------------------- */
/* Response path                                                              */
/* -------------------------------------------------------------------------- */

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * Stream the upstream as real SSE. The upstream timeout is an IDLE deadline:
 * it is armed once up front — so it doubles as a first-token deadline if no
 * chunk ever arrives — and reset after every consumed chunk, so a stream that
 * keeps producing chunks is never killed for taking long. A stream that goes
 * quiet for the full window is aborted with 504.
 */
async function streamCompletion(
  upstream: ReadableStream<IRChunk>,
  response: http.ServerResponse,
  wireModel: string,
  timeoutMs: number | undefined,
  logger: Logger,
  context: { source: string; model: string },
): Promise<void> {
  response.writeHead(200, SSE_HEADERS);
  response.flushHeaders();

  const controller = new AbortController();
  const windowMs = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const armIdleTimer = (): void => {
    timer = setTimeout(
      () =>
        controller.abort(
          new UpstreamError(
            `upstream stream was idle for more than ${windowMs}ms`,
            { status: 504, code: "upstream_timeout" },
          ),
        ),
      windowMs,
    );
  };
  armIdleTimer();

  let clientClosed = false;
  response.on("close", () => {
    clientClosed = true;
    controller.abort();
  });

  let sawFinish = false;
  let lastIndex = 0;
  try {
    for await (const chunk of upstreamChunks(upstream, controller.signal)) {
      clearTimeout(timer);
      armIdleTimer(); // activity resets the idle deadline
      lastIndex = chunk.index;
      if (chunk.finishReason != null) sawFinish = true;
      sendSseEvent(response, irChunkToOpenAIChunk(chunk, wireModel));
    }
    if (!sawFinish) {
      logger.warn("upstream ended without a finishReason; synthesizing final \"stop\" chunk", context);
      sendSseEvent(
        response,
        irChunkToOpenAIChunk({ index: lastIndex + 1, finishReason: "stop", done: true }, wireModel),
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
    logger.info("streamed completion", context);
  } catch (err) {
    if (clientClosed || response.writableEnded || response.destroyed) return;
    const body = errorBodyFor(err);
    logger.warn("upstream stream failed mid-flight", {
      ...context,
      error: body.error.message,
      status: err instanceof UpstreamError ? err.status : 500,
    });
    sendSseEvent(response, { error: body.error });
    response.write("data: [DONE]\n\n");
    response.end();
  } finally {
    clearTimeout(timer);
  }
}

async function bufferCompletion(
  upstream: ReadableStream<IRChunk>,
  response: http.ServerResponse,
  wireModel: string,
  timeoutMs: number | undefined,
  logger: Logger,
  context: { source: string; model: string },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new UpstreamError(
          `upstream did not complete within ${timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms`,
          { status: 504, code: "upstream_timeout" },
        ),
      ),
    timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  let terminalReason: "stop" | "length" | "tool_calls" = "stop";
  const pieces: string[] = [];
  try {
    for await (const chunk of upstreamChunks(upstream, controller.signal)) {
      if (chunk.content !== undefined) pieces.push(chunk.content);
      // Track the chunk that terminates the stream (it says why: stop/length/tool_calls).
      if (chunk.finishReason != null) terminalReason = chunk.finishReason;
    }
    // A stream that ended without a terminal chunk defaults to a clean "stop",
    // same as the SSE path's synthesized final chunk.
    const finishReason = terminalReason;
    sendJson(response, 200, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: wireModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: pieces.join("") },
          finish_reason: finishReason,
        },
      ],
      // Phase 0: sources do not report token usage yet; zeroed placeholders.
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    logger.info("completed (non-stream)", context);
  } catch (err) {
    respondUpstreamFailure(response, err, logger, "upstream failed while generating", context);
  } finally {
    clearTimeout(timer);
  }
}

function bytesAwareFinish(pieces: readonly string[]): "stop" | "length" | "tool_calls" {
  return "stop";
}

/**
 * Read the source's chunk stream, racing each read against `signal`. On
 * timeout the signal carries an `UpstreamError` (504); on upstream failure the
 * stream itself errors and the error propagates to the caller.
 */
async function* upstreamChunks(
  stream: ReadableStream<IRChunk>,
  signal: AbortSignal,
): AsyncGenerator<IRChunk> {
  if (signal.aborted) throw abortError(signal);
  const reader = stream.getReader();
  try {
    while (true) {
      const pending = reader.read();
      pending.catch(() => {}); // avoid unhandled rejection when cancelled
      const result = await raceWithAbort(pending, signal);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new UpstreamError("request aborted", { status: 504, code: "upstream_timeout" });
}

/* -------------------------------------------------------------------------- */
/* Errors / plumbing                                                          */
/* -------------------------------------------------------------------------- */

function errorBodyFor(err: unknown): ReturnType<typeof makeErrorBody> {
  const message = err instanceof Error && err.message.length > 0 ? err.message : "internal error";
  const status = err instanceof UpstreamError ? err.status : err instanceof ValidationError ? err.status : 500;
  const code =
    err instanceof ValidationError
      ? "invalid_request"
      : err instanceof UpstreamError && err.code !== undefined
        ? err.code
        : err instanceof UpstreamError
          ? codeForStatus(status)
          : "internal_error";
  return makeErrorBody(message, status, code);
}

function codeForStatus(status: number): string {
  switch (status) {
    case 429:
      return "rate_limit_exceeded";
    case 504:
      return "upstream_timeout";
    default:
      return "upstream_error";
  }
}

/**
 * Map an upstream failure to a proper HTTP response (before any bytes were
 * written): 429 stays 429, 504 stays 504, everything else falls to 500/502.
 */
function respondUpstreamFailure(
  response: http.ServerResponse,
  err: unknown,
  logger: Logger,
  contextMessage: string,
  context: Record<string, unknown>,
): void {
  const body = errorBodyFor(err);
  const status = err instanceof UpstreamError ? err.status : err instanceof ValidationError ? err.status : 500;
  logger.warn(contextMessage, { ...context, status, error: body.error.message });
  sendJson(response, status, body);
}

function sendSseEvent(response: http.ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(JSON.stringify(body)),
  });
  response.end(JSON.stringify(body));
}

async function readBody(
  request: http.IncomingMessage,
  limit: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = raw as Buffer;
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
