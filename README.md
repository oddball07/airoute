# AIRoute

A **local aggregation gateway** between CLI coding agents (OpenCode first) and AI
provider "sources". Sources are plugins implementing one common TypeScript
interface; the gateway presents a single OpenAI-compatible endpoint and routes
requests to the right source model (`zai/glm-4.5-air`, the alias `free-best`, ...).
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
| `packages/sources` | source plugins + the shared `openai-compat` kit (`zai` landed; `openrouter` reserved) |
| `e2e/mock-provider` | `@airoute/mock-provider` — deterministic fake OpenAI-compatible provider + mock `Source` |
| `config/airoute.json` | default config (all sources disabled — Phase 1 agent enables them) |
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
  "sources": { "registry": [ { "type": "mock", "enabled": false }, { "type": "zai", "enabled": false }, { "type": "openrouter", "enabled": false } ] },
  "rank": { "weights": { "uptime": 0.35, "quota": 0.25, "latency": 0.2, "context": 0.1, "capability": 0.1 } },
  "aliases": { "free-best": [], "free-coder": [], "free-fast": [] }
}
```

- Missing file → built-in defaults; bad JSON / invalid shape → readable
  `ConfigError` naming the offending JSON path.
- An enabled source of an **unknown type** fails config load; a *disabled*
  unknown entry is tolerated with a warning.
- Aliases: `free-best` maps to an ordered candidate list; the first candidate
  that exists is routed (proper ranking by `rank.weights` arrives in Phase 2).

## HTTP API (Phase 0/1)

| Endpoint | Notes |
| --- | --- |
| `GET /healthz` | `{ ok: true, sources: [{id, modelCount}], version }` |
| `GET /v1/models` | aggregated free-model catalog, OpenAI-shaped |
| `POST /v1/chat/completions` | OpenAI wire in/out; `stream: true` → SSE (`data: {...}` / `data: [DONE]`), flushed per chunk |

**No auth in Phase 0/1** — the gateway binds `127.0.0.1` and is meant for local
use. 120 s upstream timeout (`AbortController`); HTTP status semantics: `400`
validation, `404` unknown model (with did-you-mean hints), `403` non-free,
`429` passthrough, `500/502/504` upstream. An upstream stream that ends without
a `finishReason` gets a synthesized final `"stop"` chunk plus a warning log.

## Phase status

- **Phase 0 (done)** — skeleton, types, registry, router, streaming gateway,
  mock provider/source, CLI, tests. All sources disabled by default.
- **Phase 1 (next)** — real sources (`zai`, `openrouter`), enabling them in
  config, end-to-end run against live providers. See `packages/sources/README.md`
  for where source packages live.
- **Phase 2** — alias candidate ranking using `rank.weights`, usage tracking.
