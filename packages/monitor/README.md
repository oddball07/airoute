# @airoute/monitor

Health/uptime tracking layer for AIRoute (Phase 2). Three off-line-tested
parts: a SQLite metrics store, a staggered probe scheduler, and the circuit
breaker (`HealthTracker`).

## Quick start

```ts
import {
  createInMemoryStore,
  HealthTracker,
  ProbeScheduler,
  classifyError,
  is-like helpers,
} from "@airoute/monitor";

// In-memory store (tests) or default file-backed data/airoute.db.
const store = createInMemoryStore();

const health = new HealthTracker({ store, onStateChange: (change) => {
  process.stdout.write(`${change.sourceId}/${change.modelId}: ${change.before} → ${change.after} (${change.reason})\n`);
} });

const scheduler = new ProbeScheduler({ store, health });
scheduler.registerSources(sources); // plain Source[] — no registry dependency
scheduler.start();
// stop()/close() clear pending timers (nothing overlaps, ever).
```

## 1. MetricsStore

SQLite via Node 24's built-in `node:sqlite` (**no better-sqlite3**), WAL mode
when file-backed, default at `data/airoute.db`. Tables: `probe_runs`,
`request_events`, `model_state`, `rollup_hourly`. All statements are
prepared + parameterized; ids are the gateway-level model ids
(`"zai/glm-4.5-flash"`).

```ts
new MetricsStore(path = "data/airoute.db")   // ":memory:" supported
createInMemoryStore(file?)                    // test helper

recordProbe({ sourceId, modelId, ok, latencyMs?, errorKind?, errorDetail?, ts?, at? })
recordRequest({ sourceId, modelId, outcome, ttftMs?, totalMs?, errorKind?, ts? })
getStats(sourceId, modelId, windowMs)         // probes, rates, p50/p95 total+ttft, last±/error
getBreakerState(sourceId, modelId)            // row | undefined
getBreakerStates()                            // all rows (startup restore)
setBreakerState({ sourceId, modelId, breaker, failureStreak, cooldownUntil?, updatedAt? })
upsertRollup({ hourStart, sourceId, modelId, probes, probeOks, requests, requestOks, p50Ms?, p95Ms? })
getRollups(hourStart)
retainOlderThan(ts) → { probeRuns, requestEvents }   // caller picks the horizon (default 7d)
probeRunsFor(sourceId, modelId, limit?)       // test/diagnostic
close()                                       // idempotent
```

`request_events` records PASSIVE signals — `outcome` is one of
`"ok" | "rate_limited" | "capacity" | "server" | "timeout" | "network" |
"drop" | "auth"`. The gateway writes these in Phase 2 part 2 via
`recordRequest`.

## 2. classifyError

`classifyError(errOrMessage?: string | unknown): ErrorKind` maps anything a
source might surface onto `"rate_limited" | "capacity" | "timeout" |
"network" | "auth" | "server" | "unknown"`. Rules (documented in source,
first match wins): "overloaded" → capacity (ZAI free-tier flap quirk),
"provider returned error" → server (OpenRouter dead-upstream 429s),
"rate_l" → rate_limited, timeout phrasing (incl. "did not respond within…")
→ timeout, network/fetch/ECONN → network, balance/quota/insufficient/
invalid_api_key → auth, `http_<status>` per code (429 → rate_limited,
401/403/407 → auth, 504 → timeout, else server).

Notable typed helpers: `Outcome`/`ErrorKind` aliases, `percentiles(values)`
(nearest-rank p50/p95).

## 3. ProbeScheduler

Injectable `Clock` (`realClock` default) + `rng` (default `Math.random`) —
fake both in tests. Per source: first fire at `staggerMs * index + jitter`,
then every `probeEveryMs + jitter` (defaults 900 000 / 60 000 / 500).
Per probe `probeTimeoutMs` (30 000), global `maxConcurrentProbes` (1) —
the "one invoice" rule: ticks while busy or at capacity are SKIPPED (warn
logged), never overlapped.

```ts
new ProbeScheduler({ store, health?, clock?, rng?, logger?,
                     probeEveryMs?, jitterMs?, staggerMs?, probeTimeoutMs?,
                     maxConcurrentProbes?, onProbe?, models? })
registerSources(sources: readonly Source[]) : this
start() stop() close()                        // stop clears pending timers
pendingTimerCount                             // diagnostics/tests
probeOne(source, model, timeoutMs?)           // race probe vs timeout → ProbeResult
```

Each upcoming tick: `listModels()` (last-good cached on failure), then
`probeOne()` per model sequentially, recording classified results (store, or
the attached tracker — which records `probe_runs` AND feeds the breaker in
one call) and firing `onProbe({ sourceId, spec, probe, errorKind?, at })`.

## 4. HealthTracker (circuit breaker)

States `healthy → degraded → cooling → down`; isRoutable is true unless
`cooling`/`down` (degraded stays routable and is rank-penalized in part 2).

- 3 request failures in 10 min (`requestFailureThreshold` /
  `requestFailureWindowMs`, defaults 3/600 000) → degraded.
- Consecutive probe failures `probeFailureStreak` (3) → down (NOT routable
  until cooldown expiry + successful probe, or `manualReset()`).
- 429/capacity (probe or request): cool `cooldownMs` (300 000) with doubling
  backoff per consecutive capacity failure, capped at 30 min
  (`maxCooldownMs`). ZAI flap policy.
- auth (balance/quota/bad key): flat 30 min cooldown (`authCooldownMs`),
  automatic recovery disabled — passive ok traffic cannot heal it.
- Passive recovery: degraded + 3 consecutive ok requests
  (`passiveRecoveryStreak`) → healthy.
- Transitions: `onStateChange({ sourceId, modelId, before, after, at, reason })`
  + core-logger JSON lines; every observation re-persists `model_state`.

```ts
new HealthTracker({ store, logger?, clock?, cooldownMs?, authCooldownMs?,
                    maxCooldownMs?, requestFailureWindowMs?, requestFailureThreshold?,
                    probeFailureStreak?, passiveRecoveryStreak?, onStateChange? })
recordProbe(obs) recordRequest(obs)           // store write + breaker feed
state(s,m) isRoutable(s,m) cooldownExpiresAt(s,m)
snapshot() manualReset(s,m)
```

Breaker state survives restarts: a new tracker on the same store restores
`down`/`cooling` rows at construction.
