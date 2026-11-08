# AIRoute

A **local aggregation gateway** between CLI coding agents (OpenCode first) and AI
provider "sources". Sources are plugins implementing one common TypeScript
interface; the gateway presents a single OpenAI-compatible endpoint and routes
requests to the right source model (`zai/glm-4.5-flash`, the alias `free-best`, ...).
Free models only — paid specs cannot type-check into the catalog and are rejected
with `403` at runtime if one ever appears.

```
CLI agent (OpenCode) ──▶ airoute: POST /v1/chat/completions ──▶ source plugin ──▶ provider
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | `@airoute/core` — IR types, OpenAI wire mappers, source registry, router, config loader, logger |
| `packages/gateway` | `@airoute/gateway` — HTTP server (real SSE streaming) |
| `packages/cli` | `@airoute/cli` — thin CLI: `serve`, `models` |
| `packages/sources` | source plugins + the shared `openai-compat` kit (`zai` and `openrouter` landed; `mock` lives in `e2e/mock-provider`) |
| `e2e/mock-provider` | `@airoute/mock-provider` — deterministic fake OpenAI-compatible provider + mock `Source` |
| `config/airoute.json` | default config (`zai` + `openrouter` enabled; both self-skip without their env key) |
| `test/` | vitest suite (no network; mock source is injected in-process) |

## Commands

```bash
npm install
npm run build        # tsc -b (project references)
npm test             # vitest run
npm start            # airoute serve (node --env-file-if-exists=.env)
npm run dev          # tsx watch serve
```

The CLI's `--env-file-if-exists=.env` means: copy `.env.example` to `.env`, add
your keys (`ZAI_API_KEY`, `OPENROUTER_API_KEY`), and they're picked up in
`npm start` / `npm run dev`. A source whose env key is missing is disabled at
startup with a `source 'x' disabled: no key` log — never a crash.

## CLI

```bash
airoute serve [--port N] [--host H] [--config PATH]
airoute models [--config PATH]   # table: model id, source, context window, aliases
```

## Configuration

`config/airoute.json` (validated against `config/airoute.config.schema.json`,
editable per-deployment):

```json
{
  "$schema": "./airoute.config.schema.json",
  "server": { "host": "127.0.0.1", "port": 8787 },
  "sources": { "registry": [ { "type": "mock", "enabled": false }, { "type": "zai", "enabled": true }, { "type": "openrouter", "enabled": true } ] },
  "rank": { "weights": { "uptime": 0.35, "quota": 0.25, "latency": 0.2, "context": 0.1, "capability": 0.1 } },
  "aliases": { "free-best": [], "free-coder": [], "free-fast": [] }
}
```

- Missing file → built-in defaults; bad JSON / invalid shape → readable
  `ConfigError` naming the offending JSON path.
- An enabled source of an **unknown type** fails config load; a *disabled*
  unknown entry is tolerated with a warning.
- `sources.cacheTtlMs` (integer ms, default `60000`): how long each source's
  model catalog stays cached before `registry.models()` refetches it;
  `0` disables caching.
- Aliases: `free-best` maps to an ordered candidate list; the first candidate
  that exists is routed (proper ranking by `rank.weights` arrives in Phase 2).

## HTTP API (Phase 0/1)

| Endpoint | Notes |
| --- | --- |
| `GET /healthz` | `{ ok: true, sources: [{id, modelCount}], version }` |
| `GET /v1/models` | aggregated free-model catalog, OpenAI-shaped |
| `POST /v1/chat/completions` | OpenAI wire in/out; `stream: true` → SSE (`data: {...}` / `data: [DONE]`), flushed per chunk |

**No auth in Phase 0/1** — the gateway binds `127.0.0.1` and is meant for local
use. The 120 s upstream timeout (`AbortController`, `requestTimeoutMs`) is a
whole-request deadline for non-streaming calls and an **idle** deadline for
streams: it resets on every consumed chunk, so a long but productive
generation is never killed; a stream silent for the full window — including
one that never produced a first token — is aborted with `504`. HTTP status
semantics: `400` validation, `404` unknown model (with did-you-mean hints),
`403` non-free, `429` passthrough, `500/502/504` upstream. An upstream stream
that ends without a `finishReason` gets a synthesized final `"stop"` chunk
plus a warning log. Per-source model catalogs are cached in the registry for
`sources.cacheTtlMs` (default 60 s), with single-flight refreshes and
stale-serve on refresh failure, so requests don't hammer provider catalogs.

## Phase status

- **Phase 0 (done)** — skeleton, types, registry, router, streaming gateway,
  mock provider/source, CLI, tests.
- **Phase 1 (done)** — real sources: `zai` and `openrouter` are wired into the
  CLI factory map and enabled by default in `config/airoute.json`; each
  self-skips at startup when its env key is missing. End-to-end runs work
  against live providers. See `packages/sources/README.md` for where source
  packages live.
- **Phase 2 (next)** — per-source health monitor, alias candidate ranking
  using `rank.weights`, and usage tracking.

### Z.AI (zai source)

Default models are live-verified with a real key (see `Live smoke` below) and
carried by the code (`DEFAULT_ZAI_MODELS`) — the shipped config needs no
`models` override. Two facts worth knowing before you rely on it:

- **Thinking is disabled by default.** `glm-4.5-flash` is a thinking model:
  with default settings its whole `max_tokens` budget goes to
  `reasoning_content` and `content` comes back empty. The zai source therefore
  sends `thinking: { "type": "disabled" }` on every request (opt out with
  `"thinking": "enabled"` in the entry; proper reasoning passthrough is a
  Phase 2 IR extension).
- **`glm-4.7-flash` flaps.** It serves requests but intermittently 429s with
  an upstream-capacity "temporarily overloaded" message (not an account
  quota) — surfaced as `rate_limit_error` / probe `rate_limited` like any
  other 429.

### Live smoke (2026-11-08)

Run against real providers with a real key (non-stream + 200-after-retry
pattern):

- **Verified working end-to-end (4 models):** `zai/glm-4.5-flash`,
  `zai/glm-4.7-flash` (serves; see the flapping note above),
  `openrouter/openrouter/free`, `openrouter/nvidia/nemotron-3.5-lightning:free`.
- **Catalog adds free variants beyond `:free` ids**: the openrouter free
  filter keeps an id ending in `:free` OR both `pricing.prompt` and
  `pricing.completion` exactly `"0"` (e.g. `openrouter/openrouter/free` enters
  the catalog through the pricing rule, as observed live).
- **Dead-upstream free models 429 as `rate_limit_error`, as observed**: two
  cataloged free ids (`google/gemma-4-26b-a4b-it:free`,
  `liquid/lfm-3-1.7b:free`) answered with `UpstreamError` from dead upstreams —
  normal free-provider flakiness, no action.
- **Paid/retired ids were proven and removed** from the ZAI default list
  (`glm-4.7-flashx`/`glm-4.5-air` paid; seven `glm-4*`/`glm-5*` ids retired
  with "Unknown Model" 1211) — evidence kept in
  `packages/sources/zai/src/models.ts`.
- **Live flakiness (ρ = availability) data feeds the Phase 2 probes** — the
  per-source health monitor and alias ranking will consume exactly these
  availability observations.
