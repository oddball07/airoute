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

Picking this up in a fresh session (or after a long break)? Read
[`HANDOFF.md`](./HANDOFF.md) first — it has the current state, verification
commands, gotchas, and next steps.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | `@airoute/core` — IR types, OpenAI wire mappers, source registry, router, config loader, logger |
| `packages/gateway` | `@airoute/gateway` — HTTP server (real SSE streaming) |
| `packages/monitor` | `@airoute/monitor` — SQLite metrics store, probe scheduler, circuit breaker, model ranking |
| `packages/cli` | `@airoute/cli` — thin CLI: `serve`, `models`, `status`, `install-opencode` |
| `packages/opencode` | `@airoute/opencode` — OpenCode V2 custom-provider config builder + installer (JSONC-aware merge, free-only) |
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
airoute models [--config PATH] [--json]   # free catalog + alias resolution
airoute status [--config PATH] [--json]   # ranked models + alias health

airoute install-opencode [--project [DIR]] [--config PATH] [--url URL] [--model NAME] [--dry-run]
# write/merge providers.airoute into an OpenCode config (global by default,
# <DIR>/opencode.json with --project). Free models only; existing JSONC
# configs are merged, unrelated keys/providers preserved.
```

`airoute install-opencode` emits an OpenCode V2 custom provider:

```json
{
  "providers": {
    "airoute": {
      "name": "AIRoute",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "airoute" },
      "models": { "free-best": { "modelID": "free-best", "name": "free-best", ... } }
    }
  }
}
```

Every free model is selectable as `airoute/<id-or-alias>` (`airoute/free-best`,
`airoute/zai/glm-4.5-flash`). Model keys may contain `/` but never `#`. The
installer writes atomically (temp+rename), backs up a changed file to `<path>.bak`,
and is idempotent: an unchanged install writes nothing. `--url` installs from a
running (possibly remote) gateway's `/v1/models` instead of the local registry.

## OpenCode quick start

```bash
npm start                                    # gateway on http://127.0.0.1:8787
airoute install-opencode --project .         # writes ./opencode.json for this dir
opencode models                              # airoute/* entries appear
opencode run --model airoute/free-best "hi"
```

Use `airoute install-opencode` (no flags) to write the global config
(`~/.config/opencode/opencode.json`, honoring `XDG_CONFIG_HOME`), or `--url
http://host:port` to install from an already-running gateway.

Deterministic gate harness (no network, no keys) for failover and
cooling-model-skip checks:

```bash
node scripts/opencode-gate-gateway.mjs       # serves on 127.0.0.1:8799
airoute install-opencode --project <dir> --url http://127.0.0.1:8799
# (cd <dir>; opencode run --standalone --model airoute/free-failover "Reply with GATE-OK")
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
- Aliases: `free-best`, `free-coder` and `free-fast` map to candidate lists.
  Candidates are ordered by the live ranker (`rank.weights` + health); an
  **empty** bucket falls back to the whole free catalog, so the shipped
  defaults work without editing config. `free-coder` boosts capability and
  `free-fast` boosts latency.
- `monitor` (optional; all fields defaulted, whole section may be omitted):
  `enabled` (probes on/off), `probeEveryMs` (default 900000), `jitterMs`
  (default 60000), `requestFailureWindowMs` (default 600000) and `cooldownMs`
  (default 300000). The metrics DB path defaults to `data/airoute.db` and can
  be overridden with the `AIRROUTE_DB` env var.

## HTTP API (Phase 0/1)

| Endpoint | Notes |
| --- | --- |
| `GET /healthz` | `{ ok: true, sources: [{id, modelCount}], monitor?: { counts, models }, version }` |
| `GET /v1/models` | aggregated free-model catalog, OpenAI-shaped; a top-level `aliases` array lists alias names and `alias_details` says where each alias routes |
| `POST /v1/chat/completions` | OpenAI wire in/out; `stream: true` → SSE (`data: {...}` / `data: [DONE]`), flushed per chunk |

The `/v1/models` `aliases` field is what lets `install-opencode --url` expose a
remote gateway's aliases without a local config. `alias_details` is additive and
describes the current resolution:

```json
"aliases": ["free-best", "free-coder"],
"alias_details": {
  "free-best": { "mode": "auto", "fallback": false, "candidates": ["zai/glm-4.5-flash", "..."] }
}
```

`mode` is `explicit` (config listed models), `auto` (empty bucket → whole
catalog, ranked), or `shadowed` (a model id has the alias's name). `fallback`
means a non-empty bucket resolved to nothing and the catalog was used instead.

**Tool calling** works in both modes: `tools` / `tool_choice` are forwarded
upstream, streaming responses emit `delta.tool_calls` (arguments concatenated per
call `index`), and non-streaming responses return
`choices[0].message.tool_calls` with `finish_reason: "tool_calls"`. Assistant
`tool_calls` and `tool` role messages round-trip through the IR, so multi-step
agent loops work.

**Routing errors are alias-aware** (Phase 4). A typo gets `404 model_not_found`
with did-you-mean hints that include aliases, plus `details.aliases`; a
configured alias with no candidates gets `503 alias_unavailable`; and an alias
whose candidates are all unhealthy gets `503 all_candidates_unavailable` with
`details.candidates: [{ model, state, retry_in_ms? }]`, so callers can see why
and for how long.

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

## Health monitoring and ranking (Phase 2)

`airoute serve` opens the metrics store (`data/airoute.db`, WAL mode, rows older
than 7 days pruned at boot), restores persisted breaker state and starts one
probe scheduler per enabled source (unless `monitor.enabled` is false).

- **Active probes** — one timer per source, first fire staggered per source
  plus random jitter, steady cadence `probeEveryMs + rng * jitterMs`. A tick
  that fires while the previous cycle still runs is skipped (warn), and a
  global cap keeps only one probe cycle in flight by default. The model list is
  fetched once per cycle; on failure the last-good list is used.
- **Circuit breaker** per `(source, model)` — `healthy -> degraded -> cooling
  -> down`. Capacity/429 flaps cool down with a doubling backoff (5/10/20/30
  min, capped); auth/quota failures get a flat 30 min cooldown with no passive
  recovery; server/network/timeout streaks eventually mark a model `down`.
  State persists in `model_state`, so routing resumes from the last known
  health after a restart.
- **Passive signals** — every routed request records `ok` / `rate_limited` /
  `capacity` / `server` / `timeout` / `network` / `auth`; client disconnects
  are a neutral `drop`. Three in-window failures mark a model `degraded`;
  three passive successes recover it.
- **Failover** — alias candidates (config buckets and source-declared
  aliases) are tried in ranked order. A `stream()` that rejects with
  429/5xx/timeout/network hands the request to the next candidate;
  client-shape errors (400/404/...) do not. `cooling`/`down` models are
  skipped entirely. Failover happens before the first chunk; mid-stream
  failures still surface as an SSE error.
- **Ranking** (`rank.weights`) — uptime (probe, else request success rate),
  quota (recent capacity/auth failures), latency (inverse p50), context
  window and capability flags. `airoute status` prints the ranked table and
  the best candidate for each alias.

## Aliases (Phase 4)

Aliases are the stable names agents should use; models move, aliases don't.
The shipped config declares `free-best`, `free-coder` and `free-fast`.

- **Empty bucket** (`"free-best": []`) means "the whole free catalog", ranked
  per request, with `free-coder`/`free-fast` weighting tool support/latency
  more heavily. This is why the defaults work with no maintenance.
- **Explicit bucket** (`"pinned": ["zai/glm-4.5-flash", "openrouter/x:free"]`)
  restricts routing to those ids in that order (still health-ranked), so it is
  a preference list, not a hard pin.
- **Disappearing ids**: a non-empty bucket whose ids have all vanished falls
  back to the catalog and is reported as `auto (fallback)` — visible rather
  than silently empty.
- **Shadowing**: an alias whose name equals a real model id is reported as
  `shadowed`; the exact model id wins at routing time.

```text
aliases:
  ALIAS       MODE  BEST                                             CANDIDATES
  -----------------------------------------------------------------------------
  free-best   auto  zai/glm-4.5-flash                                18 ready
  free-coder  auto  openrouter/dots-studio/dots-3-note-preview:free  18 ready
```

`airoute models` shows catalog + alias wiring (`--json` for tooling);
`airoute status` adds live health per alias (`18 ready`, `2 cooling`, retry
hints) and `--json` emits `{ models, aliases }` with per-candidate state, so
scripts and future dashboards do not have to re-implement resolution.

## Phase status

- **Phase 0 (done)** — skeleton, types, registry, router, streaming gateway,
  mock provider/source, CLI, tests.
- **Phase 1 (done)** — real sources: `zai` and `openrouter` are wired into the
  CLI factory map and enabled by default in `config/airoute.json`; each
  self-skips at startup when its env key is missing. End-to-end runs work
  against live providers. See `packages/sources/README.md` for where source
  packages live.
- **Phase 2 (done)** — health monitor: SQLite metrics (`data/airoute.db`),
  probe scheduler, circuit breaker, passive request signals, ranked aliases
  (`free-best` / `free-coder` / `free-fast`), failover on 429/5xx/timeout,
  `airoute status` and a `monitor` block in `/healthz`. All offline-tested;
  live probing verified against ZAI + OpenRouter.
- **Phase 3 (done)** — OpenCode integration: `@airoute/opencode` builds and
  installs the V2 custom provider (`airoute install-opencode`), merging into
  existing JSONC configs (atomic write, `.bak`, idempotent, dry-run); the
  catalog can come from a running gateway (`--url`). Tool calling now works
  end-to-end (IR `toolCalls`, wire `delta.tool_calls`, non-stream
  `message.tool_calls`). Verified with real OpenCode against live ZAI and a
  deterministic gate harness (`scripts/opencode-gate-gateway.mjs`): discovery,
  streaming + multi-turn context, tool calls, failover on a 429 first
  candidate, and skipping a cooling model. 256 offline tests.
- **Phase 4 (done)** — alias UX: `/v1/models` `alias_details` (mode/fallback/
  ranked candidates), alias-aware 404 hints and `503 alias_unavailable` /
  `all_candidates_unavailable` with per-candidate health and retry windows,
  alias sections in `airoute models` / `airoute status`, and `--json` for both
  (logs go to stderr so stdout stays parseable). 274 offline tests; the Phase 3
  OpenCode gates were re-run against a live gateway and the deterministic
  harness.
- **Phase 5 (deferred)** — Anthropic `/v1/messages` → Claude Code. Parked by
  request (2026-11-09); OpenCode remains the only target. Next OpenCode work is
  capability-aware routing, install diagnostics, and catalog/config sync.

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
