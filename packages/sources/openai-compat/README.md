# @airoute/openai-compat

Shared kit for OpenAI-compatible chat-completions providers. A source plugin
(zai, openrouter, any future OpenAI-wire provider) plugs in its provider
details and gets a full AIRoute `Source`. Everything here is offline-testable.

## Quick start

```ts
import { createOpenAICompatSource } from "@airoute/openai-compat";

const source = createOpenAICompatSource({
  id: "my-source",               // ModelSpec.sourceId for every model
  baseUrl: "https://api.example.com/v4", // chat lives at `${baseUrl}/chat/completions`
  apiKey: process.env.MY_API_KEY,        // optional; sent as `Authorization: Bearer …`
  headers: { "x-provider-flavour": "free" }, // optional extra static headers
  models: [                       // static list; this kit never calls /models
    {
      id: "model-flash",          // provider model id
      label: "Model Flash",
      contextWindow: 128_000,     // 0/omitted = unknown
      caps: { tools: true, vision: false, reasoning: false },
      aliases: [],                // source-level alias names
    },
  ],
  timeoutMs: 60_000,              // idle timeout; default 60s
  fetch: globalThis.fetch,        // inject in tests (see "Offline testing")
});
```

The returned object satisfies `Source` from `@airoute/core` and additionally
exposes `complete()` (non-streaming single completion — the path `probe()`
uses). Register it either directly (`registry.register(source)`) or through a
`SourceFactory` that validates its config entry and calls this kit.

## Options

| Option | Notes |
| --- | --- |
| `id` | Required, non-empty. Server as `source.id` and `ModelSpec.sourceId`. |
| `baseUrl` | Required, must be `http(s)://…`; trailing slashes trimmed. |
| `apiKey` | Optional; omit the `Authorization` header when unset. **Never logged.** |
| `headers` | Optional record of strings, under per-request headers. |
| `models` | Required array of `SourceModelDef`. Empty array allowed (advertises nothing). |
| `timeoutMs` | Optional positive ms; default 60 000. Idle timeout for the fetch and every stream read. |
| `fetch` | Optional replacement for `globalThis.fetch` — the offline-test seam. |

All options are validated; malformed values throw `ConfigError` with a readable
message naming the offending option (`"baseUrl" must start with http:// or
https://`, `models[2].contextWindow must be a non-negative integer`, …).

## Streaming semantics (read before subclassing)

1. **The kit always requests `stream: true` upstream**, regardless of
   `request.stream`. The gateway facing the HTTP client decides how the answer
   is presented (SSE out or buffered JSON); the source↔provider leg is always
   SSE so bytes flow incrementally end to end.
2. **Nothing is buffered whole.** The upstream body is read line by line as
   the provider sends it, and each IR chunk is produced only when the consumer
   of the returned `ReadableStream` pulls (real backpressure).
3. **IR contract enforcement**: emitted chunks have sequential `index` from 0;
   the role appears on (or is injected onto) exactly the first chunk; a final
   chunk carries `finishReason` + `done: true`. If the upstream ends without a
   finish reason — even mid-stream — a terminal `"stop"` chunk is synthesized.
4. **SSE parsing**: `data: {...}` JSON lines only; `: comment` keep-alives and
   non-`data:` lines are ignored; `[DONE]` stops parsing; CRLF and LF both work;
   a malformed JSON line is skipped rather than killing the stream.
5. **Non-SSE responses are handled gracefully**: a non-2xx (JSON or not) body
   is parsed best-effort into `UpstreamError`; a 2xx `{"error": {...}}` body
   becomes `UpstreamError` 502 with the provider's own `error.code` when
   present; a 2xx chat-completion JSON body (provider streamed even though
   asked otherwise, or ignored `stream:false`) is converted into an equivalent
   chunk stream / `complete()` result.

### Error mapping (non-2xx or JSON error bodies)

| Upstream status | `UpstreamError.code` |
| --- | --- |
| 401 | `invalid_api_key` |
| 403 | `insufficient_quota` |
| 429 | `rate_limit_exceeded` |
| 5xx | `upstream_error` |
| other | provider's own `error.code` string when present |

`status` is passed through (network failures become 502 / `network_error`;
idling out becomes 504 / `upstream_timeout`).

## `ModelSpec` shape produced

```ts
{
  id: "<sourceId>/<def.id>",     // gateway-level model id
  sourceId: def source id,
  sourceModelId: def.id,          // sent upstream as `model`
  label: def.label ?? def.id,
  contextWindow: def.contextWindow ?? 0,  // 0 = unknown
  caps: { tools, vision, reasoning },     // defaults { true, false, false }
  free: true,                     // kit models are free-only by construction
  aliases: def.aliases ?? [],
  meta: { contextWindow, raw },   // light + documented: contextWindow mirrors
                                  // the spec field; raw shallow-copies def
}
```

## `probe()`

Minimal chat completion — `max_tokens: 1`,
`messages: [{ role: "user", content: "ping" }]`, `stream: false` — plus the
`x-airoute-probe: 1` header so probes are identifiable in provider logs.
Results:

- 2xx completion → `{ ok: true, latencyMs, at }`
- 429 → `{ ok: false, error: "rate_limited" }`
- idle timeout → `{ ok: false, error: "timeout" }`
- fetch failure → `{ ok: false, error: "network_error" }`
- other HTTP failure → `{ ok: false, error: "http_<status>" }`

(latencyMs is present on failures too; `at` is an ISO timestamp.)

## `complete()`

`complete(model, request)` — non-streaming chat completion, always
`stream: false`. Returns `{ content, finishReason, role }`. Used internally by
`probe()` and useful to host sources. If the provider streams although asked
not to, the SSE body is parsed and concatenated transparently.

## Offline testing

- Inject `fetch`. To control exact byte framing (comment lines, CRLF, chunk
  boundaries, mid-stream drops), have it return a `Response` built around any
  body: `new Response("data: {...}\\n\\ndata: [DONE]\\n\\n", { status: 200,
  headers: { "content-type": "text/event-stream" } })` or
  `new Response(myReadableStream)`. Nothing hits the network.
- Against the repo's deterministic mock provider: start it
  (`startMockProvider()` from `@airoute/mock-provider`) and point the kit at
  `baseUrl: "http://127.0.0.1:<port>/v1"` — the mock's chat endpoint is
  OpenAI-compatible at `/v1/chat/completions`, and the kit appends
  `/chat/completions`.

## Logging

The kit never logs — in particular it can never emit an API key. Host sources
may wrap it with `createLogger` from `@airoute/core`; log ids and statuses,
never headers.

## Exported API

```ts
createOpenAICompatSource(options: OpenAICompatOptions): OpenAICompatSource
DEFAULT_OPENAI_COMPAT_TIMEOUT_MS: number
DEFAULT_OPENAI_COMPAT_CAPS: Readonly<ModelCaps>

interface OpenAICompatOptions { id; baseUrl; apiKey?; headers?; models: SourceModelDef[]; timeoutMs?; fetch? }
interface SourceModelDef { id; label?; contextWindow?; caps?: Partial<ModelCaps>; aliases?: string[] }
interface OpenAICompatCompletion { content; finishReason; role }
interface OpenAICompatSource extends Source { complete(model, request): Promise<OpenAICompatCompletion> }

// validation helpers (usable by host sources for their config entries)
validateBaseUrl(value: unknown, context: string): string
validateTimeoutMs(value: unknown, context: string): number
validateSourceModelDefs(value: unknown, context: string): SourceModelDef[]

// from sse.ts (internal seams, exported for testing)
class SseTimeoutError extends Error
awaitWithTimeout<T>(promise, timeoutMs?, onTimeout?): Promise<T>
readLines(body: ReadableStream<Uint8Array>, timeoutMs?): AsyncGenerator<string>
isPositiveTimeout(ms): ms is number
```
