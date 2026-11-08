/**
 * Shared kit for OpenAI-compatible chat-completions providers.
 *
 * A source package (zai, openrouter, ...) plugs its provider-specific details
 * — base URL, static model list, extra headers — into `createOpenAICompatSource`
 * and gets a full AIRoute `Source` implementation for free:
 *
 * - `listModels()` — maps the static `SourceModelDef` list onto `ModelSpec`s
 *   (`id: "<sourceId>/<providerModelId>"`, `free: true`, light `meta`).
 * - `stream()` — POSTs `<baseUrl>/chat/completions` and converts OpenAI SSE to
 *   IR chunks (see "Streaming semantics" below).
 * - `probe()` — a minimal NON-streaming completion (`max_tokens: 1`,
 *   `messages: [{ role: "user", content: "ping" }]`) with the
 *   `x-airoute-probe: 1` header so probes are identifiable in provider logs.
 * - `complete()` — public non-streaming completion used by `probe()`; also
 *   handy for host sources that want a "just give me the answer" path.
 *
 * STREAMING SEMANTICS (contract-followers, read this):
 *
 * 1. The kit ALWAYS requests `stream: true` upstream, regardless of
 *    `request.stream`. The HTTP client-facing gateway decides how the answer
 *    is presented (SSE passthrough vs buffered JSON); the source↔provider leg
 *    is always an incremental SSE stream so nothing is buffered end-to-end.
 * 2. Upstream is consumed incrementally and pull-based: lines are read as the
 *    provider sends them and each IR chunk is only produced when the consumer
 *    of the returned ReadableStream pulls. The whole response is never
 *    buffered in memory. (Tests that need exact byte framing can inject a
 *    `fetch` returning any `new Response(readableStreamOrString, ...)`)
 * 3. The returned chunk stream enforces the IR contract: sequential `index`
 *    from 0, the role attached to (or injected onto) the first chunk only, and
 *    a terminal chunk with `finishReason` + `done: true` — synthesized as
 *    `"stop"` if the upstream ended (even mid-flight) without one.
 * 4. `data: [DONE]` stops parsing; `: comment` keep-alive lines and lines that
 *    are not `data:` are ignored; CRLF and LF line endings both work.
 *
 * ERROR MAPPING (non-2xx or JSON error bodies):
 *   status 401 → code "invalid_api_key"
 *   status 403 → code "insufficient_quota"
 *   status 429 → code "rate_limit_exceeded"
 *   status 5xx → code "upstream_error"
 *   other      → the provider's own `error.code` string when present
 * A 2xx response that carries a JSON `{"error": {...}}` body (some gateways
 * answer this way) becomes `UpstreamError` with status 502 and the provider's
 * code. Idle timeouts map to 504 / "upstream_timeout"; fetch-level network
 * failures map to 502 / "network_error".
 *
 * OFFLINE TESTS: inject `fetch` — no network required. Against the repo's
 * mock provider, pass `baseUrl: "http://127.0.0.1:<port>/v1"` (the mock's
 * chat endpoint is `/v1/chat/completions`, the kit appends `/chat/completions`).
 *
 * The kit itself never logs — and never logs API keys in any case.
 */
import { ReadableStream } from "node:stream/web";
import {
  ConfigError,
  UpstreamError,
  irRequestToOpenAI,
  openAIChunkToIR,
  type IRChunk,
  type IRRequest,
  type ModelCaps,
  type ModelSpec,
  type OpenAIChatRequest,
  type ProbeResult,
  type Role,
  type Source,
} from "@airoute/core";
import { SseTimeoutError, awaitWithTimeout, isPositiveTimeout, readLines } from "./sse.js";

/* -------------------------------------------------------------------------- */
/* Public option / result types                                               */
/* -------------------------------------------------------------------------- */

/** Idle timeout applied to upstream fetches and stream reads. */
export const DEFAULT_OPENAI_COMPAT_TIMEOUT_MS = 60_000;

/** Default capability set for every kit model (overridable per model). */
export const DEFAULT_OPENAI_COMPAT_CAPS: Readonly<ModelCaps> = {
  tools: true,
  vision: false,
  reasoning: false,
};

/** One model definition a host source declares for its provider. */
export interface SourceModelDef {
  /** Provider model id, e.g. "glm-4.5-flash". */
  id: string;
  /** Human label; defaults to `def.id`. */
  label?: string;
  /** Tokens; 0/omitted = unknown. */
  contextWindow?: number;
  /** Per-model override of `{ tools, vision, reasoning }`. */
  caps?: Partial<ModelCaps>;
  /** Source-level alias names (resolved by the router). */
  aliases?: string[];
}

export interface OpenAICompatOptions {
  /** Source id, e.g. "zai". Also the `ModelSpec.sourceId` of every model. */
  id: string;
  /** Chat completions live at `${baseUrl}/chat/completions`. */
  baseUrl: string;
  /** When set, requests carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Extra static headers merged beneath per-request headers. */
  headers?: Record<string, string>;
  /**
   * Provider-specific body fields merged LAST into the outgoing chat
   * completion request — on top of the fields mapped from the IR request —
   * so sources can send provider knobs the Phase 1 IR has no field for
   * (e.g. zai's `thinking` control). Precedence: an `extraBody` field beats
   * the mapped IR fields, but LOSES to the three kit-owned fields `model`,
   * `messages` and `stream`: source-specific overrides of those three are
   * ignored (they pin request identity and the always-stream-upstream
   * contract).
   */
  extraBody?: Record<string, unknown>;
  /** Static model list (this kit does not fetch /models). */
  models: SourceModelDef[];
  /** Idle timeout; default {@link DEFAULT_OPENAI_COMPAT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable fetch — the offline-test seam. */
  fetch?: typeof fetch;
}

/** Non-streaming completion result (`complete()`, backing `probe()`). */
export interface OpenAICompatCompletion {
  content: string;
  finishReason: "stop" | "length" | "tool_calls" | null;
  role: Role;
}

/**
 * A kit-backed `Source`, plus the public non-streaming `complete()` path
 * (`Source` itself only requires listModels/stream/probe).
 */
export interface OpenAICompatSource extends Source {
  /** Non-streaming chat completion. Always sends `stream: false`. */
  complete(model: ModelSpec, request: IRRequest): Promise<OpenAICompatCompletion>;
}

/* -------------------------------------------------------------------------- */
/* Option validation (readable ConfigError on any malformed option)           */
/* -------------------------------------------------------------------------- */

const CAP_KEYS = ["tools", "vision", "reasoning"] as const;
const ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate & normalize a `baseUrl` option (trims trailing slashes). */
export function validateBaseUrl(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${context}: "baseUrl" must be a non-empty http(s) URL string`);
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ConfigError(`${context}: "baseUrl" must start with http:// or https:// (got "${trimmed}")`);
  }
  return trimmed;
}

/** Validate a `timeoutMs` option. */
export function validateTimeoutMs(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${context}: "timeoutMs" must be a positive number of milliseconds`);
  }
  return value;
}

/** Validate an array-ish `models` value into `SourceModelDef[]`. */
export function validateSourceModelDefs(value: unknown, context: string): SourceModelDef[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${context}: "models" must be an array of model definitions`);
  }
  return value.map((item, index) => validateModelDef(item, `${context}: models[${index}]`));
}

function validateModelDef(value: unknown, at: string): SourceModelDef {
  if (!isRecord(value)) throw new ConfigError(`${at} must be an object`);
  const id = value["id"];
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ConfigError(`${at}.id must be a non-empty string`);
  }
  const def: SourceModelDef = { id };

  const label = value["label"];
  if (label !== undefined) {
    if (typeof label !== "string") throw new ConfigError(`${at}.label must be a string`);
    def.label = label;
  }
  const contextWindow = value["contextWindow"];
  if (contextWindow !== undefined) {
    if (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow < 0) {
      throw new ConfigError(`${at}.contextWindow must be a non-negative integer (0 = unknown)`);
    }
    def.contextWindow = contextWindow;
  }
  const caps = value["caps"];
  if (caps !== undefined) {
    if (!isRecord(caps)) throw new ConfigError(`${at}.caps must be an object`);
    const out: Partial<ModelCaps> = {};
    for (const key of CAP_KEYS) {
      const v = caps[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") throw new ConfigError(`${at}.caps.${key} must be a boolean`);
      out[key] = v;
    }
    def.caps = out;
  }
  const aliases = value["aliases"];
  if (aliases !== undefined) {
    if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string")) {
      throw new ConfigError(`${at}.aliases must be an array of strings`);
    }
    def.aliases = aliases as string[];
  }
  return def;
}

function validateHeaders(value: Record<string, string> | undefined, context: string): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
    throw new ConfigError(`${context}: "headers" must be a record of strings`);
  }
}

/* -------------------------------------------------------------------------- */
/* Source construction                                                        */
/* -------------------------------------------------------------------------- */

export function createOpenAICompatSource(options: OpenAICompatOptions): OpenAICompatSource {
  const idValue = isRecord(options) ? options["id"] : undefined;
  if (typeof idValue !== "string" || idValue.length === 0) {
    throw new ConfigError(`openai-compat source: option "id" must be a non-empty string`);
  }
  const id = idValue;
  const baseUrl = validateBaseUrl(options.baseUrl, `openai-compat source "${id}"`);
  if (options.apiKey !== undefined && typeof options.apiKey !== "string") {
    throw new ConfigError(`openai-compat source "${id}": option "apiKey" must be a string`);
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new ConfigError(`openai-compat source "${id}": option "fetch" must be a function`);
  }
  if (options.extraBody !== undefined && !isRecord(options.extraBody)) {
    throw new ConfigError(`openai-compat source "${id}": option "extraBody" must be an object`);
  }
  validateHeaders(options.headers, `openai-compat source "${id}"`);
  const timeoutMs =
    options.timeoutMs === undefined
      ? DEFAULT_OPENAI_COMPAT_TIMEOUT_MS
      : validateTimeoutMs(options.timeoutMs, `openai-compat source "${id}"`);
  const models = validateSourceModelDefs(options.models, `openai-compat source "${id}"`);
  const apiKey = options.apiKey ?? undefined;
  const extraBody = options.extraBody; // undefined = no extra fields (no-op)
  const fetchFn = options.fetch ?? globalThis.fetch;
  const chatUrl = `${baseUrl}/chat/completions`;

  const modelSpecs = models.map((def) => specFor(id, def));

  const source: OpenAICompatSource = {
    id,
    listModels,
    stream,
    probe,
    complete,
  };
  return source;

  /* ---- listModels -------------------------------------------------------- */

  function listModels(): Promise<ModelSpec[]> {
    return Promise.resolve(modelSpecs.slice());
  }

  /* ---- stream ------------------------------------------------------------ */

  async function stream(args: { model: ModelSpec; request: IRRequest }): Promise<ReadableStream<IRChunk>> {
    const { model, request } = args;
    if (model.sourceId !== id) {
      throw new UpstreamError(
        `source "${id}" cannot serve model "${model.id}" (owned by "${model.sourceId}")`,
        { status: 500, code: "source_model_mismatch" },
      );
    }
    const body = irRequestToOpenAI(request);
    body.model = model.sourceModelId;
    // Kit contract: ALWAYS `stream: true` upstream. The caller-facing gateway
    // picks SSE vs buffered JSON; see the module header comment.
    body.stream = true;
    return openStream(body);
  }

  async function openStream(body: OpenAIChatRequest): Promise<ReadableStream<IRChunk>> {
    const abort = new AbortController();
    let res: Response;
    try {
      const fetchPromise = fetchChat(body, abort.signal);
      res = await awaitWithTimeout(fetchPromise, timeoutMs, (err) => abort.abort(err));
    } catch (err) {
      abort.abort();
      throw classifyRequestError(err);
    }

    if (!res.ok) throw await upstreamErrorFromResponse(res);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Graceful: some gateways answer non-stream JSON even when asked to
      // stream. Parse error bodies as errors; a completion-shaped body is
      // converted into an equivalent chunk stream.
      const completion = await readCompletionBody(res);
      return chunkStreamFromCompletion(completion);
    }
    if (res.body === null) {
      throw new UpstreamError(`upstream returned an empty streaming body`, {
        status: 502,
        code: "upstream_error",
      });
    }

    const chunks = irChunkStreamFromSse(res.body, timeoutMs);
    return new ReadableStream<IRChunk>({
      async pull(controller) {
        try {
          const next = await chunks.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (err) {
          controller.error(wrapReadError(err));
        }
      },
      async cancel() {
        // Cancel = client went away or gateway timed out: stop the upstream
        // request and unwind the SSE generator.
        abort.abort();
        try {
          await chunks.return(undefined);
        } catch {
          // The generator's own error path has already run; nothing to do.
        }
      },
    });
  }

  /* ---- complete + probe -------------------------------------------------- */

  async function complete(model: ModelSpec, request: IRRequest): Promise<OpenAICompatCompletion> {
    return completeInternal(model, request, undefined);
  }

  async function completeInternal(
    model: ModelSpec,
    request: IRRequest,
    extraHeaders: Record<string, string> | undefined,
  ): Promise<OpenAICompatCompletion> {
    const body = irRequestToOpenAI(request);
    body.model = model.sourceModelId;
    body.stream = false; // non-stream path (probe + complete)

    let res: Response;
    try {
      res = await postChat(body, extraHeaders);
    } catch (err) {
      throw classifyRequestError(err);
    }
    if (!res.ok) throw await upstreamErrorFromResponse(res);

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // Provider streamed although we asked not to: parse and concatenate.
      if (res.body === null) {
        throw new UpstreamError("upstream returned an empty streaming body", {
          status: 502,
          code: "upstream_error",
        });
      }
      return completionFromSseBody(res.body);
    }
    return readCompletionBody(res);
  }

  async function probe(model: ModelSpec): Promise<ProbeResult> {
    const at = new Date().toISOString();
    const started = Date.now();
    try {
      await completeInternal(
        model,
        // Minimal, cheapest possible probe; identified in provider logs via
        // the x-airoute-probe header.
        { model: model.id, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
        { "x-airoute-probe": "1" },
      );
      return { ok: true, latencyMs: Date.now() - started, at };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: probeErrorLabel(err), at };
    }
  }

  /* ---- error classification ---------------------------------------------- */

  /**
   * Short, stable probe error labels: "rate_limited" (429), "timeout",
   * "network_error", "http_<status>" otherwise.
   */
  function probeErrorLabel(err: unknown): string {
    if (err instanceof UpstreamError) {
      if (err.code === "network_error") return "network_error";
      if (err.status === 504) return "timeout";
      if (err.status === 429) return "rate_limited";
      return `http_${err.status}`;
    }
    if (err instanceof SseTimeoutError) return "timeout";
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") return "timeout";
    if (err instanceof TypeError) return "network_error";
    return "probe_failed";
  }

  /* ---- shared request helpers -------------------------------------------- */

  function requestHeaders(extra: Record<string, string> | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...options.headers,
    };
    if (apiKey !== undefined && apiKey.length > 0) headers["authorization"] = `Bearer ${apiKey}`;
    return extra === undefined ? headers : { ...headers, ...extra };
  }

  function fetchChat(
    body: OpenAIChatRequest,
    signal: AbortSignal | undefined,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const init: RequestInit & { signal?: AbortSignal } = {
      method: "POST",
      headers: requestHeaders(extraHeaders),
      body: JSON.stringify(withExtraBody(body)),
    };
    if (signal !== undefined) init.signal = signal;
    return fetchFn(chatUrl, init);
  }

  /**
   * Merge `extraBody` into the outgoing chat-completion body: source-specific
   * fields land ON TOP of the mapped IR fields, but the kit-owned `model`,
   * `messages` and `stream` are re-applied last so they always win (they pin
   * request identity and the kit's always-stream-upstream contract).
   */
  function withExtraBody(body: OpenAIChatRequest): OpenAIChatRequest & Record<string, unknown> {
    if (extraBody === undefined) return body as OpenAIChatRequest & Record<string, unknown>;
    const merged = { ...body, ...extraBody } as OpenAIChatRequest & Record<string, unknown>;
    merged.model = body.model;
    merged.messages = body.messages;
    merged.stream = body.stream;
    return merged;
  }

  /** A short-lived POST: whole request (connection + response headers) raced against the timeout. */
  async function postChat(
    body: OpenAIChatRequest,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const abort = new AbortController();
    const fetchPromise = fetchChat(body, abort.signal, extraHeaders);
    return await awaitWithTimeout(fetchPromise, timeoutMs, (err) => abort.abort(err));
  }

  async function readErrorBodyText(res: Response): Promise<string | null> {
    try {
      return await awaitWithTimeout(res.text(), timeoutMs);
    } catch (err) {
      if (err instanceof SseTimeoutError) throw wrapReadError(err);
      return null; // unreadable body — callers fall back to status-based message
    }
  }

  async function upstreamErrorFromResponse(res: Response): Promise<UpstreamError> {
    const text = await readErrorBodyText(res);
    const info = parseErrorBody(text);
    const message =
      info.message !== undefined && info.message.length > 0
        ? info.message
        : `upstream responded ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    return new UpstreamError(message, {
      status: res.status,
      code: mappedCode(res.status, info.code),
    });
  }

  /** Parse a 2xx non-SSE body into a completion, mapping error bodies to UpstreamError. */
  async function readCompletionBody(res: Response): Promise<OpenAICompatCompletion> {
    const text = await readErrorBodyText(res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text ?? "");
    } catch {
      throw new UpstreamError("upstream returned a non-JSON response where a chat completion was expected", {
        status: 502,
        code: "upstream_error",
      });
    }
    if (isRecord(parsed) && isRecord(parsed["error"])) {
      const errObj = parsed["error"];
      const message = typeof errObj["message"] === "string" ? errObj["message"] : "upstream returned an error body";
      const code = errObj["code"];
      throw new UpstreamError(message, {
        status: 502,
        code: typeof code === "string" && code.length > 0 ? code : "upstream_error",
      });
    }
    return completionFromBody(parsed);
  }

  async function completionFromSseBody(body: ReadableStream<Uint8Array>): Promise<OpenAICompatCompletion> {
    let content = "";
    let finish: OpenAICompatCompletion["finishReason"] = "stop";
    let role: Role | undefined;
    const chunks = irChunkStreamFromSse(body, timeoutMs);
    try {
      for await (const chunk of chunks) {
        if (chunk.content !== undefined) content += chunk.content;
        if (chunk.finishReason != null) finish = chunk.finishReason;
        if (role === undefined && chunk.role !== undefined) role = chunk.role;
      }
    } catch (err) {
      throw wrapReadError(err);
    }
    return { content, finishReason: finish, role: role ?? "assistant" };
  }

  /* ---- internal fns shared with closures above --------------------------- */

  function classifyRequestError(err: unknown): UpstreamError {
    if (err instanceof UpstreamError) return err;
    if (err instanceof SseTimeoutError) {
      return new UpstreamError(`upstream did not respond within ${timeoutMs}ms`, {
        status: 504,
        code: "upstream_timeout",
      });
    }
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return new UpstreamError("upstream request aborted", { status: 504, code: "upstream_timeout" });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new UpstreamError(`upstream request failed: ${message}`, { status: 502, code: "network_error" });
  }

  function wrapReadError(err: unknown): UpstreamError {
    if (err instanceof UpstreamError) return err;
    if (err instanceof SseTimeoutError) {
      return new UpstreamError(`upstream stalled for more than ${timeoutMs}ms while streaming`, {
        status: 504,
        code: "upstream_timeout",
      });
    }
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return new UpstreamError("upstream read aborted", { status: 504, code: "upstream_timeout" });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new UpstreamError(`upstream connection failed while streaming: ${message}`, {
      status: 502,
      code: "upstream_error",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (module scope)                                                */
/* -------------------------------------------------------------------------- */

/** Map one validated `SourceModelDef` onto the gateway `ModelSpec` shape. */
function specFor(sourceId: string, def: SourceModelDef): ModelSpec {
  const caps = { ...DEFAULT_OPENAI_COMPAT_CAPS, ...(def.caps ?? {}) };
  return {
    id: `${sourceId}/${def.id}`,
    sourceId,
    sourceModelId: def.id,
    label: def.label ?? def.id,
    contextWindow: def.contextWindow ?? 0,
    caps: { tools: caps.tools, vision: caps.vision, reasoning: caps.reasoning },
    free: true,
    aliases: def.aliases ?? [],
    // Light + documented: `contextWindow` mirrors the spec field, `raw` mirrors
    // the model definition that produced this spec (shallow-cloned).
    meta: { contextWindow: def.contextWindow ?? 0, raw: { ...def } },
  };
}

/** Status → OpenAI-style error code, per the mapping in the module header. */
function mappedCode(status: number, providerCode: unknown): string | undefined {
  if (status === 401) return "invalid_api_key";
  if (status === 403) return "insufficient_quota";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "upstream_error";
  if (typeof providerCode === "string" && providerCode.length > 0) return providerCode;
  return undefined;
}

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/** Best-effort parse of an error body: `{ error: { message, code } }` style. */
function parseErrorBody(text: string | null): { message?: string; code?: unknown } {
  if (text === null || text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { message: snippet(text) };
    const errObj = isRecord(parsed["error"]) ? parsed["error"] : parsed;
    const message = typeof errObj["message"] === "string" ? errObj["message"] : snippet(text);
    return { message, code: errObj["code"] };
  } catch {
    return { message: snippet(text) };
  }
}

/** Parse a non-stream chat-completion JSON body; throws on malformed shapes. */
function completionFromBody(parsed: unknown): OpenAICompatCompletion {
  if (!isRecord(parsed)) {
    throw new UpstreamError("upstream response was not a chat completion object", {
      status: 502,
      code: "upstream_error",
    });
  }
  const choices = parsed["choices"];
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new UpstreamError('upstream response is missing "choices"', {
      status: 502,
      code: "upstream_error",
    });
  }
  const first = choices[0] as Record<string, unknown>;
  const message = isRecord(first["message"]) ? first["message"] : undefined;
  const rawContent = message?.["content"];
  const content = typeof rawContent === "string" ? rawContent : "";
  // message.reasoning_content (thinking models, e.g. ZAI) is deliberately
  // dropped: reasoning_content passthrough is a Phase 2 IR extension; today a
  // reasoning-only non-stream completion maps to a content:"" completion and
  // finishReason passes through untouched.
  const rawRole = message?.["role"];
  const role = typeof rawRole === "string" && ROLES.includes(rawRole) ? (rawRole as Role) : "assistant";
  const rawFinish = first["finish_reason"];
  const finishReason =
    rawFinish === "stop" || rawFinish === "length" || rawFinish === "tool_calls" ? rawFinish : null;
  return { content, finishReason, role };
}

/**
 * True when any choice delta of this wire chunk carries a
 * `reasoning_content` field (ZAI thinking models, OpenRouter free-router
 * reasoning variants). The Phase 1 IR has no reasoning lane, so the kit
 * strips the text and emits the chunk as a normal content-absent delta.
 */
function wireCarriesReasoningDelta(chunk: unknown): boolean {
  if (!isRecord(chunk) || !Array.isArray(chunk["choices"])) return false;
  return chunk["choices"].some(
    (choice) => isRecord(choice) && isRecord(choice["delta"]) && choice["delta"]["reasoning_content"] !== undefined,
  );
}

/**
 * Convert SSE bytes into contract-conformant IR chunks:
 * sequential index, role on the first chunk (injected when the provider omits
 * it), terminal `finishReason`-carrying chunk (synthesized as "stop" when the
 * upstream ends without one), data lines after the finish are ignored.
 */
function irChunkStreamFromSse(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
): AsyncGenerator<IRChunk, void, undefined> {
  return (async function* () {
    let index = 0;
    let roleSent = false;
    let finished = false;
    for await (const line of readLines(body, timeoutMs)) {
      if (line.length === 0) continue; // event separator
      if (line.startsWith(":")) continue; // SSE comment / keep-alive
      if (!line.startsWith("data:")) continue; // event:, id:, retry:, strays
      let payload = line.slice("data:".length);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      if (payload === "[DONE]") break; // terminal sentinel: stop consuming
      if (finished) break; // anything after a finish chunk is dropped

      let wire: unknown;
      try {
        wire = JSON.parse(payload);
      } catch {
        continue; // a malformed line must not kill the stream
      }
      const ir = openAIChunkToIR(wire);
      const hasRole = ir.role !== undefined;
      const hasContent = ir.content !== undefined;
      const hasFinish = ir.finishReason != null;
      // reasoning_content passthrough is a Phase 2 IR extension; today
      // providers' reasoning-only chunks (e.g. ZAI interleaved chatcmpl ids,
      // OpenRouter free-router reasoning) normalize to empty content deltas:
      // the reasoning text is stripped and the chunk still flows with
      // content-absent shape + correct role/finish bookkeeping.
      const hasData = hasRole || hasContent || hasFinish || wireCarriesReasoningDelta(wire);
      if (!hasData) continue; // keep-alive / empty choices

      const out: IRChunk = { index: index++ };
      if (!roleSent) {
        out.role = ir.role ?? "assistant";
        roleSent = true;
      }
      if (hasContent) out.content = ir.content;
      if (hasFinish) {
        out.finishReason = ir.finishReason;
        out.done = true;
        finished = true;
      }
      yield out;
    }
    if (!finished) {
      // Upstream ended (possibly mid-flight) without a finish reason: the IR
      // contract needs a terminal chunk, so synthesize a clean "stop".
      yield { index: index++, finishReason: "stop", done: true };
    }
  })();
}

/** Turn a small non-streaming completion into a contract-conformant chunk stream. */
function chunkStreamFromCompletion(completion: OpenAICompatCompletion): ReadableStream<IRChunk> {
  const finish = completion.finishReason ?? "stop";
  const parts: IRChunk[] = [{ index: 0, role: completion.role }];
  if (completion.content.length > 0) parts[0]!.content = completion.content;
  parts.push({ index: 1, finishReason: finish, done: true });
  let i = 0;
  return new ReadableStream<IRChunk>({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[i]!);
      i++;
    },
  });
}
