# AIRoute — session handoff brief

**Purpose of this file:** start a new agent session from here when the previous
one is near its context limit. Everything below is current as of the last commit
on `main`; verify with the commands in §2 before trusting details.

Repo: `D:\tools\airoute` · Branch: `main` · Written: 2026-11-09

---

## 1. What this project is

AIRoute is a **local aggregation gateway** between CLI coding agents (OpenCode
first) and free AI provider "sources". A source is a plugin implementing one
TypeScript interface; the gateway exposes a single OpenAI-compatible endpoint
and routes each request to a free model (`zai/glm-4.5-flash`, alias `free-best`, …).

```
CLI agent (OpenCode) ──▶ airoute: POST /v1/chat/completions ──▶ source plugin ──▶ provider
```

**Non-negotiable rules (do not relax these):**

- **Free models only.** Paid models must never be routable. The catalog type
  gates them, and the gateway returns `403` if one ever reaches routing.
- **OpenCode is the primary CLI.** Claude Code, Cline, and other CLIs are
  secondary and stay untouched until the OpenCode gates pass (they do now for
  Phase 3, but no secondary-CLI work has started).
- **API-first.** Every model is reached through a stable machine endpoint;
  web-chat automation (WebSource) is a deferred Phase 6 bonus tier.
- **Secrets live in `.env` only.** Never read, print, log, or commit `.env`.
  The user's keys are `ZAI_API_KEY` and `OPENROUTER_API_KEY` (no Qwen key).
- **Offline tests.** `npm test` must never hit the network or real providers.
- **Minimal dependencies.** Do not add runtime deps without a reason.

## 2. Verify current state first

```powershell
cd D:\tools\airoute
git log --oneline -3      # expect the Phase 4.5 commit at the tip, or newer
git status --short        # should be clean
npm run build             # tsc -b, must be clean
npm test                  # vitest run - 283 tests / 26 files, all offline
```

If the test count is lower than expected, stop and find out what was reverted
before continuing.

## 3. Architecture map

| Path | What lives there |
| --- | --- |
| `packages/core` | IR types, OpenAI wire mappers, source registry, router, tokens (`estimateRequestTokens`), config loader, logger, errors |
| `packages/gateway` | HTTP server: `/healthz`, `/v1/models`, `/v1/chat/completions` (SSE + non-stream); capability-aware candidate filter |
| `packages/monitor` | SQLite metrics store (`node:sqlite`), probe scheduler, circuit breaker, ranker |
| `packages/opencode` | OpenCode V2 custom-provider config builder (honest alias metadata) + atomic installer + JSONC parser |
| `packages/cli` | `serve`, `models`, `status`, `install-opencode` (+ `alias-view`) |
| `packages/sources/openai-compat` | shared kit: request building, SSE parsing, tool-call accumulation |
| `packages/sources/zai`, `packages/sources/openrouter` | concrete free-tier sources |
| `e2e/mock-provider` | deterministic fake provider + mock `Source` used by tests |
| `scripts/opencode-gate-gateway.mjs` | deterministic gate harness (port 8799) for failover + degraded skip |
| `config/airoute.json` | default config (zai + openrouter enabled, self-skip without key) |
| `test/` | vitest suite, no network |
| `C:\Users\hiten\.opencode\plan\airoute-plan.md` | the long-form project plan and phase table |

Key module entry points:

- `packages/gateway/src/server.ts` — `startGateway(options)`, routing, failover,
  non-stream aggregation (`bufferCompletion`), SSE forwarding.
- `packages/core/src/openai-wire.ts` — OpenAI ⇄ IR both directions, including
  `delta.tool_calls`; **`choices[0].index` is always 0**, while `IRChunk.index`
  is a chunk sequence counter (do not "fix" this back).
- `packages/opencode/src/install.ts` — atomic write (temp + rename), `.bak`,
  dry-run, idempotency.
- `packages/opencode/src/config.ts` — catalog → `ModelSpec`, free-only and `#`
  guards, provider block builder/merge.

## 4. Running it

```powershell
npm start                     # gateway on http://127.0.0.1:8787 (uses .env if present)
airoute models --json         # catalog + alias wiring (machine-readable)
airoute status                # ranked free models + per-alias health
airoute status --json         # same, for scripts/dashboards
airoute install-opencode      # write/merge global OpenCode config
airoute install-opencode --project .            # project-local ./opencode.json
airoute install-opencode --url http://127.0.0.1:8787   # install from a gateway catalog
```

OpenCode end-to-end:

```powershell
opencode models                                   # airoute/* entries appear
opencode run --standalone --model airoute/free-best "hi"
opencode run --standalone --auto --model airoute/zai/glm-4.5-flash "Use the shell tool to run: echo TOOL-OK"
```

Providers exposed by the gateway: `zai/*`, `openrouter/*`, plus aliases
`free-best`, `free-coder`, `free-fast`. Selectable ids are `airoute/<key>`.

## 5. Phase status

- **Phase 0 (done)** — skeleton, IR, registry, router, streaming gateway, mock, CLI.
- **Phase 1 (done)** — live ZAI + OpenRouter free sources, catalog caching, idle stream timeout.
- **Phase 2 (done)** — SQLite metrics, probe scheduler, circuit breaker, passive
  signals, ranker, health-aware failover, `airoute status`, `/healthz` monitor block.
- **Phase 3 (done, commit `ccce547`)** — `@airoute/opencode`, `install-opencode`,
  tool calling end-to-end, `/v1/models` aliases, gate harness.
- **Phase 4 (done)** — alias UX: `/v1/models` `alias_details`, alias-aware
  routing errors (`alias_unavailable`, `all_candidates_unavailable` with
  per-candidate state/retry), alias tables in `models`/`status`, `--json` for
  both. 274 tests; Phase 3 gates re-run green (live + harness).
- **Phase 4.5 (done)** — capability-aware routing: filter by source → breaker →
  `caps.tools` → estimated context (`chars/4`); `400 model_incompatible` for an
  exact model that cannot comply, `503 no_compatible_candidate` when no alias
  candidate fits, each rejection explained in `details.candidates`. Aliases
  installed into OpenCode now carry honest `capabilities.tools` and
  `limit.context` derived from their candidates. 283 tests; live tool call
  routed to a tools-capable model, tool-less model 400s, gates green.

Phase 3 gates that were actually run green against real OpenCode:

1. Discovery — `opencode models` lists `airoute/*`.
2. Streaming + multi-turn — reply `OK`, then `-c` recalled `PINEAPPLE`.
3. Tool calls — ran `echo TOOL-OK` through the shell tool.
4. Failover — alias whose first candidate 429s → `STEADY-OK`.
5. Degraded skip — alias whose first candidate is cooling → `STEADY-OK`.

Gates 4–5 are reproducible offline:

```powershell
node scripts/opencode-gate-gateway.mjs                     # listens on 127.0.0.1:8799
airoute install-opencode --project $tmp --url http://127.0.0.1:8799
# in $tmp: opencode run --standalone --model airoute/free-failover "Reply with GATE-OK"
```

## 6. Known limitations / open items

- **Reasoning content is dropped.** ZAI thinking models send `reasoning_content`;
  the kit strips it and the zai source disables thinking by default. Proper
  passthrough is still an unresolved IR extension.
- **`glm-4.7-flash` flaps** with upstream-capacity 429s (not account quota).
- **Failover/degradation evidence** for the gate comes from the deterministic
  harness; live providers cannot be forced to 429 on demand.
- **No auth on the gateway.** It binds `127.0.0.1`; it is not safe to expose.
- **Remote:** `origin` → `https://github.com/oddball07/airoute.git`, `main` tracks it.
  Git identity is still `AIRoute Phase 0 <airoute@local>` unless changed.
- Reasoning/cost reporting beyond `cost: {input:0, output:0}` is not implemented.

## 7. Next up (OpenCode only)

**Phase 5 is deferred** by the user (2026-11-09): no Claude Code / Anthropic
adapter work until they ask. Keep the effort on OpenCode.

Candidate next chunks, roughly in value order:

1. **Install diagnostics**: `airoute doctor` (gateway reachable, config current,
   aliases routable, keys present) and `install-opencode --check` (exit 1 when
   the installed config is stale, for a pre-flight script).
2. **Catalog/config sync**: free catalogs churn; re-running install is manual
   today. Options: `install-opencode --watch`, a `serve` startup notice when the
   installed config is stale, or a documented one-liner.

Capability-aware routing (formerly item 1) shipped in Phase 4.5: tool requests
skip `caps.tools: false` candidates, oversized prompts skip small-context
candidates, and `install-opencode` derives alias capabilities/context from the
alias's candidates.

Re-run the Phase 3 gates (live + harness) after routing changes.

## 8. Environment gotchas (learned the hard way)

- **Windows PowerShell 5**: no `&&` / `||`; use `;`. Native stderr like
  `opencode.exe :` is expected noise — check `exit=$LASTEXITCODE` and answer text.
- **Build before running**: the CLI runs `packages/cli/dist`, so `npm run build`
  after every source change.
- **`Start-Job` children die with the PowerShell invocation.** Start the gateway
  and run `opencode` in the *same* script, or use a detached process.
- **PowerShell 5 `>` redirects write UTF-16**, which breaks `JSON.parse` /
  `ConvertFrom-Json`. Capture JSON via `cmd /c "node … > file"` or
  `fs.readFileSync(file, "utf8")`.
- **`--json` keeps stdout clean**: info logs are routed to stderr, but any
  process writing to stdout (custom `console.log`) would still corrupt it.
- **Stale listeners** hold ports 8787/8799. Kill with
  `Get-NetTCPConnection -LocalPort <p> -State Listen` → `Stop-Process`.
- **Temp dirs** used by gate runs: `%TEMP%\airoute-e2e` (real gateway) and
  `%TEMP%\airoute-gate` (harness).
- **`data/airoute.db`** holds live probe metrics (gitignored); `AIRROUTE_DB`
  overrides the path. Delete it to reset health state.
- OpenCode v2.2.6 is installed; use `--standalone` for isolated runs and
  `--auto` to auto-approve tools in non-interactive checks.

## 9. Model / agent preferences

- For coding agents and subagents, the user asked for
  `opencode/glm-5.3-flash-free#high` (free-tier quota reasons). If that model is
  rate-limited, tell the user rather than silently switching.

## 10. Handoff checklist (fill in before starting the new session)

- [ ] Last thing I was working on: ______
- [ ] Uncommitted changes: ______ (`git status --short`)
- [ ] Decision waiting on the user: ______
- [ ] Anything I tried that failed: ______

## 11. What to tell the new session

> Read `HANDOFF.md` in `D:\tools\airoute` first, then run the §2 verification
> commands. Continue from §7 (OpenCode-only queue) unless I say otherwise. Keep
> the rules in §1: free models only, OpenCode first, no secrets in logs, offline
> tests.
