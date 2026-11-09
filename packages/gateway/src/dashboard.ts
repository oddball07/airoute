/**
 * Phase 7 dashboard: one self-contained HTML page plus the JSON snapshot it
 * polls (`/dashboard` and `/dashboard/api/snapshot`).
 *
 * Design constraints:
 * - No new dependencies and no build step: the page is a string in this
 *   module, and all rendering happens in the browser from the snapshot.
 * - No external assets (fonts/CDN): the dashboard works offline like the rest
 *   of the project.
 * - Everything the page shows is derived from the gateway's own registry,
 *   breaker state and metrics store, so it cannot disagree with routing.
 *
 * Honest limits (shown in the UI): AIRoute does not know provider quota
 * balances. The "pressure" bar is the share of observed failures that are
 * capacity/429 or auth/quota failures over the window — a proxy, not a
 * remaining-quota meter.
 */
import {
  DEFAULT_RANK_WEIGHTS,
  describeAliases,
  type AliasMap,
  type ModelCaps,
  type ModelSpec,
  type RankWeights,
} from "@airoute/core";
import {
  rankModels,
  type ActivityRow,
  type CircuitState,
  type MetricsStore,
  type StatsSnapshot,
} from "@airoute/monitor";

/** Where the page is served. */
export const DASHBOARD_PATH = "/dashboard";
/** Where the page gets its data. */
export const DASHBOARD_SNAPSHOT_PATH = "/dashboard/api/snapshot";
/** Heatmap window (24 hourly cells). */
export const DASHBOARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DASHBOARD_BUCKET_MS = 60 * 60 * 1000;
/** How often the page re-fetches the snapshot. */
export const DASHBOARD_REFRESH_MS = 3_000;
export const DASHBOARD_RECENT_LIMIT = 25;

/** Metrics reads the dashboard needs (a `MetricsStore` satisfies this). */
export type DashboardStore = Pick<
  MetricsStore,
  "getStats" | "getUptimeBuckets" | "getRecentActivity" | "getFailureKinds"
>;

/** Health reads the dashboard needs (a `HealthTracker` satisfies this). */
export interface DashboardHealth {
  state(sourceId: string, modelId: string): CircuitState;
  cooldownExpiresAt(sourceId: string, modelId: string): number;
}

/** Options configured once by `airoute serve`. */
export interface DashboardOptions {
  store?: DashboardStore;
  weights?: RankWeights;
  /** Server start (ms epoch), used for the uptime display. */
  startedAt?: number;
  /** AIRoute config path, shown in the header tooltip. */
  configPath?: string;
  refreshMs?: number;
  windowMs?: number;
  bucketMs?: number;
  recentLimit?: number;
}

export interface DashboardInput extends DashboardOptions {
  specs: readonly ModelSpec[];
  aliasMap?: AliasMap;
  ranker?: (candidates: readonly ModelSpec[], alias: string) => readonly ModelSpec[];
  health?: DashboardHealth;
  version: string;
  /** Injectable clock for tests. */
  now?: number;
}

export interface DashboardCell {
  /** ms epoch bucket start. */
  start: number;
  probes: number;
  probeOks: number;
  requests: number;
  requestOks: number;
  /** Probe success rate, else request success rate, else null. */
  rate: number | null;
}

export type DashboardStateCounts = Record<CircuitState, number>;

export interface DashboardModel {
  id: string;
  source: string;
  label: string;
  contextWindow: number;
  caps: ModelCaps;
  state: CircuitState;
  routable: boolean;
  /** 0..1 weighted ranking score (0 for cooling/down). */
  score: number;
  breakdown: Record<string, number>;
  uptime: number | null;
  requestSuccessRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftP50Ms: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorKind: string | null;
  /** ms until the active cooldown ends; 0 when none. */
  cooldownMsRemaining: number;
  buckets: DashboardCell[];
}

export interface DashboardAlias {
  alias: string;
  mode: "explicit" | "auto" | "shadowed";
  fallback: boolean;
  candidates: string[];
  best: string | null;
  counts: DashboardStateCounts;
}

export interface DashboardSource {
  id: string;
  models: number;
  counts: DashboardStateCounts;
  /** (healthy + degraded) / models. */
  availability: number;
  failures: Record<string, number>;
  totalFailures: number;
  /**
   * Share of failures that are capacity/429 or auth/quota. `null` when there
   * are no failures in the window (no evidence either way).
   */
  quotaPressure: number | null;
}

export interface DashboardSummary {
  models: number;
  routable: number;
  counts: DashboardStateCounts;
  sources: number;
  /** Mean of per-model uptime over models that have observations. */
  uptimeAvg: number | null;
}

export interface DashboardActivity {
  kind: "probe" | "request";
  ts: number;
  source: string;
  model: string;
  ok: boolean | null;
  outcome: string | null;
  latencyMs: number | null;
  errorKind: string | null;
  errorDetail: string | null;
}

export interface DashboardSnapshot {
  generatedAt: number;
  startedAt: number;
  uptimeMs: number;
  version: string;
  configPath?: string;
  refreshMs: number;
  window: { ms: number; bucketMs: number; count: number };
  summary: DashboardSummary;
  sources: DashboardSource[];
  models: DashboardModel[];
  aliases: DashboardAlias[];
  recent: DashboardActivity[];
}

/** Failure kinds that indicate provider pressure (not general breakage). */
const PRESSURE_KINDS = new Set(["capacity", "rate_limited", "auth"]);

/** Build the JSON snapshot the dashboard renders. Pure apart from `now`. */
export function buildDashboardSnapshot(input: DashboardInput): DashboardSnapshot {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? DASHBOARD_WINDOW_MS;
  const bucketMs = input.bucketMs ?? DASHBOARD_BUCKET_MS;
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));
  const since = now - windowMs;
  const weights = input.weights ?? DEFAULT_RANK_WEIGHTS;
  const store = input.store;

  const stateOf = (spec: ModelSpec): CircuitState =>
    input.health?.state(spec.sourceId, spec.id) ?? "healthy";

  const statsById = new Map<string, StatsSnapshot | null>();
  for (const spec of input.specs) {
    statsById.set(spec.id, store?.getStats(spec.sourceId, spec.id, windowMs) ?? null);
  }

  const ranked = rankModels(
    input.specs.map((spec) => {
      const stats = statsById.get(spec.id) ?? null;
      return {
        spec,
        stats,
        state: stateOf(spec),
        lastErrorKind: stats?.lastErrorKind ?? null,
      };
    }),
    weights,
  );

  /* Heatmap: one fixed-length row per model, cells filled from the store. */
  const series = new Map<string, DashboardCell[]>();
  for (const spec of input.specs) {
    const cells: DashboardCell[] = [];
    for (let i = 0; i < bucketCount; i++) {
      cells.push({
        start: since + i * bucketMs,
        probes: 0,
        probeOks: 0,
        requests: 0,
        requestOks: 0,
        rate: null,
      });
    }
    series.set(spec.id, cells);
  }
  for (const row of store?.getUptimeBuckets(since, bucketMs) ?? []) {
    if (row.bucket < 0 || row.bucket >= bucketCount) continue;
    const cells = series.get(row.modelId);
    const cell = cells?.[row.bucket];
    if (cell === undefined) continue;
    cell.probes = row.probes;
    cell.probeOks = row.probeOks;
    cell.requests = row.requests;
    cell.requestOks = row.requestOks;
    cell.rate =
      row.probes > 0
        ? row.probeOks / row.probes
        : row.requests > 0
          ? row.requestOks / row.requests
          : null;
  }

  const models: DashboardModel[] = ranked.map((entry) => {
    const spec = entry.spec;
    const stats = statsById.get(spec.id) ?? null;
    const state = stateOf(spec);
    const cooldownUntil = input.health?.cooldownExpiresAt(spec.sourceId, spec.id) ?? 0;
    return {
      id: spec.id,
      source: spec.sourceId,
      label: spec.label,
      contextWindow: spec.contextWindow,
      caps: spec.caps,
      state,
      routable: entry.routable,
      score: Number(entry.score.toFixed(4)),
      breakdown: {
        uptime: Number(entry.breakdown.uptime.toFixed(4)),
        quota: Number(entry.breakdown.quota.toFixed(4)),
        latency: Number(entry.breakdown.latency.toFixed(4)),
        context: Number(entry.breakdown.context.toFixed(4)),
        capability: Number(entry.breakdown.capability.toFixed(4)),
      },
      uptime: stats?.probeSuccessRate ?? stats?.requestSuccessRate ?? null,
      requestSuccessRate: stats?.requestSuccessRate ?? null,
      p50Ms: stats?.p50Ms ?? null,
      p95Ms: stats?.p95Ms ?? null,
      ttftP50Ms: stats?.ttftP50Ms ?? null,
      lastSuccessAt: stats?.lastSuccessAt ?? null,
      lastFailureAt: stats?.lastFailureAt ?? null,
      lastErrorKind: stats?.lastErrorKind ?? null,
      cooldownMsRemaining: cooldownUntil > now ? cooldownUntil - now : 0,
      buckets: series.get(spec.id) ?? [],
    };
  });

  /* Per-source availability + failure mix. */
  const failureRows = store?.getFailureKinds(since) ?? [];
  const sources = new Map<string, DashboardSource>();
  const sourceOf = (id: string): DashboardSource => {
    const existing = sources.get(id);
    if (existing !== undefined) return existing;
    const created: DashboardSource = {
      id,
      models: 0,
      counts: { healthy: 0, degraded: 0, cooling: 0, down: 0 },
      availability: 0,
      failures: {},
      totalFailures: 0,
      quotaPressure: null,
    };
    sources.set(id, created);
    return created;
  };
  for (const spec of input.specs) {
    const source = sourceOf(spec.sourceId);
    source.models += 1;
    source.counts[stateOf(spec)] += 1;
  }
  for (const row of failureRows) {
    const source = sourceOf(row.sourceId);
    source.failures[row.kind] = (source.failures[row.kind] ?? 0) + row.count;
    source.totalFailures += row.count;
  }
  for (const source of sources.values()) {
    source.availability =
      source.models === 0 ? 0 : (source.counts.healthy + source.counts.degraded) / source.models;
    if (source.totalFailures > 0) {
      let pressure = 0;
      for (const kind of PRESSURE_KINDS) pressure += source.failures[kind] ?? 0;
      source.quotaPressure = pressure / source.totalFailures;
    }
  }
  const sourceList = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));

  /* Alias routing, using the same ranker/filters as `/v1/models`. */
  const aliasMap = input.aliasMap ?? {};
  const descriptions = describeAliases(
    input.specs,
    aliasMap,
    input.ranker !== undefined ? { rankCandidates: input.ranker } : {},
  );
  const specsById = new Map(input.specs.map((spec) => [spec.id, spec] as const));
  const aliases: DashboardAlias[] = descriptions.map((description) => {
    const counts: DashboardStateCounts = { healthy: 0, degraded: 0, cooling: 0, down: 0 };
    let best: string | null = null;
    for (const id of description.candidates) {
      const spec = specsById.get(id);
      if (spec === undefined) continue;
      const state = stateOf(spec);
      counts[state] += 1;
      if (best === null && (state === "healthy" || state === "degraded")) best = id;
    }
    return {
      alias: description.alias,
      mode: description.mode,
      fallback: description.fallback,
      candidates: description.candidates,
      best,
      counts,
    };
  });

  const counts: DashboardStateCounts = { healthy: 0, degraded: 0, cooling: 0, down: 0 };
  for (const model of models) counts[model.state] += 1;
  const uptimes = models
    .map((model) => model.uptime)
    .filter((value): value is number => value !== null);
  const uptimeAvg =
    uptimes.length === 0 ? null : uptimes.reduce((sum, value) => sum + value, 0) / uptimes.length;

  const recent: DashboardActivity[] = (store?.getRecentActivity(since, input.recentLimit ?? DASHBOARD_RECENT_LIMIT) ?? []).map(
    (row: ActivityRow) => ({
      kind: row.kind,
      ts: row.ts,
      source: row.sourceId,
      model: row.modelId,
      ok: row.ok,
      outcome: row.outcome,
      latencyMs: row.latencyMs,
      errorKind: row.errorKind,
      errorDetail: row.errorDetail,
    }),
  );

  const startedAt = input.startedAt ?? now;
  return {
    generatedAt: now,
    startedAt,
    uptimeMs: Math.max(0, now - startedAt),
    version: input.version,
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
    refreshMs: input.refreshMs ?? DASHBOARD_REFRESH_MS,
    window: { ms: windowMs, bucketMs, count: bucketCount },
    summary: {
      models: models.length,
      routable: models.filter((model) => model.routable).length,
      counts,
      sources: sourceList.length,
      uptimeAvg,
    },
    sources: sourceList,
    models,
    aliases,
    recent,
  };
}

/** The dashboard page. Static string: all data arrives via fetch. */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIRoute dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --ink: #16181d;
    --muted: #6b7280;
    --line: #e5e7eb;
    --accent: #2563eb;
    --ok: #16a34a;
    --warn: #d97706;
    --bad: #dc2626;
    --dim: #9ca3af;
    --cell-empty: #eef0f3;
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --ink: #e5e7eb;
      --muted: #9ca3af;
      --line: #262b36;
      --accent: #60a5fa;
      --ok: #4ade80;
      --warn: #fbbf24;
      --bad: #f87171;
      --dim: #6b7280;
      --cell-empty: #1f232c;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 16px 22px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 2;
  }
  .brand { font-size: 16px; font-weight: 700; letter-spacing: 0.2px; }
  .brand span { font-weight: 400; color: var(--muted); font-size: 13px; margin-left: 6px; }
  .meta { color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
  main { max-width: 1440px; margin: 0 auto; padding: 18px 22px 48px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); margin: 26px 0 10px; }
  h2 .hint { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 8px; }
  section { margin-bottom: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .card, .source, .alias {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: var(--shadow); padding: 12px 14px;
  }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; }
  .card .v { font-size: 22px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .card .s { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
  .source .head { display: flex; align-items: baseline; gap: 8px; }
  .source .name { font-weight: 650; }
  .source .sub { color: var(--muted); margin-left: auto; font-size: 11px; }
  .bar { height: 6px; border-radius: 99px; background: var(--cell-empty); overflow: hidden; margin-top: 10px; }
  .bar > i { display: block; height: 100%; border-radius: 99px; background: var(--ok); }
  .bar.pressure > i { background: var(--warn); }
  .rowlabel { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .chip {
    border: 1px solid var(--line); border-radius: 99px; padding: 1px 7px;
    color: var(--muted); font-size: 10.5px; white-space: nowrap;
  }
  .aliases { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
  .alias .head { display: flex; align-items: baseline; gap: 8px; }
  .alias .name { font-weight: 650; font-size: 14px; }
  .alias .best { color: var(--muted); margin-top: 6px; overflow-wrap: anywhere; }
  .alias ul { list-style: none; margin: 8px 0 0; padding: 0; }
  .alias li { display: flex; gap: 7px; align-items: baseline; padding: 2px 0; overflow-wrap: anywhere; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.healthy { background: var(--ok); }
  .dot.degraded { background: var(--warn); }
  .dot.cooling { background: var(--warn); }
  .dot.down { background: var(--bad); }
  .table-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; box-shadow: var(--shadow); }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; background: transparent; }
  tr:last-child td { border-bottom: 0; }
  td.model { max-width: 520px; overflow: hidden; text-overflow: ellipsis; }
  td.num, th.num { text-align: right; }
  .pill { border-radius: 99px; padding: 1px 7px; font-size: 10.5px; border: 1px solid var(--line); }
  .pill.healthy { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .pill.degraded { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .pill.cooling { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .pill.down { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
  .mini { display: inline-block; width: 54px; height: 5px; border-radius: 99px; background: var(--cell-empty); overflow: hidden; vertical-align: middle; margin-right: 6px; }
  .mini > i { display: block; height: 100%; background: var(--ok); }
  .heatmap { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; box-shadow: var(--shadow); }
  .hrow { display: grid; grid-template-columns: minmax(190px, 300px) repeat(24, minmax(12px, 1fr)); gap: 3px; align-items: center; }
  .hrow + .hrow { margin-top: 3px; }
  .hlabel { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
  .cell { height: 16px; border-radius: 3px; background: var(--cell-empty); }
  .cell.r1 { background: color-mix(in srgb, var(--bad) 72%, var(--cell-empty)); }
  .cell.r2 { background: color-mix(in srgb, var(--warn) 62%, var(--cell-empty)); }
  .cell.r3 { background: color-mix(in srgb, var(--ok) 38%, var(--cell-empty)); }
  .cell.r4 { background: color-mix(in srgb, var(--ok) 72%, var(--cell-empty)); }
  .legend { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10.5px; margin-top: 9px; }
  .legend .cell { width: 16px; height: 10px; }
  .spacer { flex: 1; }
  #error {
    margin: 0; padding: 10px 22px; background: color-mix(in srgb, var(--bad) 12%, var(--panel));
    border-bottom: 1px solid var(--line); color: var(--bad);
  }
  .hidden { display: none; }
  .empty { color: var(--muted); padding: 10px 2px; }
  footer { color: var(--dim); font-size: 10.5px; margin-top: 28px; text-align: center; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<header>
  <div class="brand">AIRoute<span>gateway dashboard</span></div>
  <div class="meta" id="meta">connecting…</div>
</header>
<div id="error" class="hidden"></div>
<main>
  <section class="cards" id="summary"></section>
  <section><h2>Sources · availability &amp; pressure<span class="hint">pressure = share of failures that are 429/capacity or auth/quota</span></h2><div class="sources" id="sources"></div></section>
  <section><h2>Alias routing<span class="hint">order matches failover; the first routable candidate is best</span></h2><div class="aliases" id="aliases"></div></section>
  <section><h2>Model ranking<span class="hint">weighted score; cooling/down sort last</span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th class="num">#</th><th>model</th><th class="num">score</th><th>state</th><th>uptime</th><th class="num">p50</th><th class="num">context</th><th>caps</th><th>last error</th></tr></thead>
      <tbody id="models"></tbody>
    </table></div>
  </section>
  <section><h2>Uptime · last 24h<span class="hint">per hourly bucket; hover a cell for counts</span></h2>
    <div class="heatmap" id="heatmap"></div>
    <div class="legend"><span>worse</span><i class="cell r1"></i><i class="cell r2"></i><i class="cell r3"></i><i class="cell r4"></i><span>better</span><span class="spacer"></span><span>no data</span><i class="cell"></i><span>older → newer</span></div>
  </section>
  <section><h2>Live activity<span class="hint">newest probes and requests in the window</span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th>time</th><th>kind</th><th>model</th><th>result</th><th class="num">latency</th></tr></thead>
      <tbody id="activity"></tbody>
    </table></div>
  </section>
  <footer>OpenCode: select <strong>airoute/free-best</strong> · JSON: <a href="/dashboard/api/snapshot">/dashboard/api/snapshot</a></footer>
</main>
<script>
(function () {
  "use strict";
  var byId = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function shortId(id, max) {
    if (id.length <= max) return id;
    return "…" + id.slice(id.length - (max - 1));
  }
  function pct(value) {
    return value === null || value === undefined ? "—" : Math.round(value * 100) + "%";
  }
  function ms(value) {
    if (value === null || value === undefined) return "—";
    return value >= 1000 ? (value / 1000).toFixed(1) + "s" : Math.round(value) + "ms";
  }
  function duration(value) {
    var s = Math.floor(value / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + (s % 60) + "s";
    return s + "s";
  }
  function clock(ts) { return new Date(ts).toLocaleTimeString(); }
  function statePill(state) { return el("span", "pill " + state, state); }
  function miniBar(rate) {
    var wrap = el("span", "mini");
    var fill = el("i");
    fill.style.width = rate === null || rate === undefined ? "0%" : Math.round(rate * 100) + "%";
    if (rate !== null && rate !== undefined && rate < 0.8) fill.style.background = "var(--warn)";
    if (rate !== null && rate !== undefined && rate < 0.5) fill.style.background = "var(--bad)";
    wrap.appendChild(fill);
    return wrap;
  }
  function card(k, v, s) {
    var node = el("div", "card");
    node.appendChild(el("div", "k", k));
    node.appendChild(el("div", "v", v));
    if (s) node.appendChild(el("div", "s", s));
    return node;
  }
  function bar(rate, pressure) {
    var wrap = el("div", "bar" + (pressure ? " pressure" : ""));
    var fill = el("i");
    fill.style.width = Math.round((rate || 0) * 100) + "%";
    wrap.appendChild(fill);
    return wrap;
  }

  function renderSummary(s) {
    var host = byId("summary");
    clear(host);
    host.appendChild(card("models", s.summary.models, s.summary.sources + " source(s)"));
    host.appendChild(card("routable", s.summary.routable, s.summary.counts.cooling + " cooling · " + s.summary.counts.down + " down"));
    host.appendChild(card("avg uptime", pct(s.summary.uptimeAvg), "24h probes / requests"));
    host.appendChild(card("gateway uptime", duration(s.uptimeMs), "v" + s.version));
  }

  function renderSources(sources) {
    var host = byId("sources");
    clear(host);
    if (!sources.length) { host.appendChild(el("div", "empty", "no sources")); return; }
    sources.forEach(function (src) {
      var node = el("div", "source");
      var head = el("div", "head");
      head.appendChild(el("span", "name", src.id));
      head.appendChild(el("span", "sub", src.models + " models · " + pct(src.availability) + " ready"));
      node.appendChild(head);
      node.appendChild(bar(src.availability, false));
      node.appendChild(el("div", "rowlabel", "availability · " + src.counts.healthy + " healthy, " + src.counts.degraded + " degraded, " + src.counts.cooling + " cooling, " + src.counts.down + " down"));
      if (src.quotaPressure !== null) {
        node.appendChild(bar(src.quotaPressure, true));
        node.appendChild(el("div", "rowlabel", "pressure · " + pct(src.quotaPressure) + " of " + src.totalFailures + " failures"));
      } else {
        node.appendChild(el("div", "rowlabel", "pressure · no failures observed"));
      }
      var chips = el("div", "chips");
      Object.keys(src.failures).sort().forEach(function (kind) {
        chips.appendChild(el("span", "chip", kind + " " + src.failures[kind]));
      });
      node.appendChild(chips);
      host.appendChild(node);
    });
  }

  function renderAliases(aliases) {
    var host = byId("aliases");
    clear(host);
    if (!aliases.length) { host.appendChild(el("div", "empty", "no aliases configured")); return; }
    aliases.forEach(function (alias) {
      var node = el("div", "alias");
      var head = el("div", "head");
      head.appendChild(el("span", "name", alias.alias));
      head.appendChild(el("span", "pill", alias.mode + (alias.fallback ? " (fallback)" : "")));
      node.appendChild(head);
      node.appendChild(el("div", "best", "best: " + (alias.best || "(none routable)")));
      var list = el("ul");
      alias.candidates.slice(0, 7).forEach(function (id) {
        var item = el("li");
        item.appendChild(el("span", "dot"));
        item.appendChild(el("span", null, id));
        list.appendChild(item);
      });
      var hidden = alias.candidates.length - 7;
      if (hidden > 0) {
        var more = el("li");
        more.appendChild(el("span", "chip", "+" + hidden + " more"));
        list.appendChild(more);
      }
      node.appendChild(list);
      node.appendChild(el("div", "rowlabel", alias.counts.healthy + " ready · " + alias.counts.degraded + " degraded · " + alias.counts.cooling + " cooling · " + alias.counts.down + " down"));
      host.appendChild(node);
    });
  }

  function renderModels(models, aliases) {
    var host = byId("models");
    clear(host);
    if (!models.length) {
      var row = el("tr");
      var cell = el("td", "empty", "no models");
      cell.colSpan = 9;
      row.appendChild(cell);
      host.appendChild(row);
      return;
    }
    models.forEach(function (model, index) {
      var tr = el("tr");
      tr.appendChild(el("td", "num", index + 1));
      var name = el("td", "model", model.id);
      name.title = model.id + " · " + model.label;
      tr.appendChild(name);
      tr.appendChild(el("td", "num", model.score.toFixed(3)));
      var state = el("td");
      state.appendChild(statePill(model.state));
      tr.appendChild(state);
      var uptime = el("td");
      uptime.appendChild(miniBar(model.uptime));
      uptime.appendChild(document.createTextNode(pct(model.uptime)));
      tr.appendChild(uptime);
      tr.appendChild(el("td", "num", ms(model.p50Ms)));
      tr.appendChild(el("td", "num", model.contextWindow > 0 ? Math.round(model.contextWindow / 1000) + "k" : "—"));
      var caps = el("td");
      ["tools", "vision", "reasoning"].forEach(function (flag) {
        if (model.caps[flag]) caps.appendChild(el("span", "chip", flag));
      });
      tr.appendChild(caps);
      tr.appendChild(el("td", null, model.lastErrorKind || "—"));
      host.appendChild(tr);
    });
  }

  function renderHeatmap(snapshot) {
    var host = byId("heatmap");
    clear(host);
    if (!snapshot.models.length) { host.appendChild(el("div", "empty", "no models")); return; }
    snapshot.models.forEach(function (model) {
      var row = el("div", "hrow");
      var label = el("div", "hlabel", shortId(model.id, 42));
      label.title = model.id;
      row.appendChild(label);
      model.buckets.forEach(function (bucket) {
        var cell = el("div", "cell");
        if (bucket.rate !== null) {
          cell.className = "cell " + (bucket.rate >= 0.95 ? "r4" : bucket.rate >= 0.8 ? "r3" : bucket.rate >= 0.5 ? "r2" : "r1");
        }
        cell.title = clock(bucket.start) + " · probes " + bucket.probeOks + "/" + bucket.probes + " · requests " + bucket.requestOks + "/" + bucket.requests;
        row.appendChild(cell);
      });
      host.appendChild(row);
    });
  }

  function renderActivity(recent) {
    var host = byId("activity");
    clear(host);
    if (!recent.length) {
      var row = el("tr");
      var cell = el("td", "empty", "no activity in the window");
      cell.colSpan = 5;
      row.appendChild(cell);
      host.appendChild(row);
      return;
    }
    recent.forEach(function (item) {
      var tr = el("tr");
      tr.appendChild(el("td", null, clock(item.ts)));
      tr.appendChild(el("td", null, item.kind));
      var model = el("td", "model", item.model);
      model.title = item.model;
      tr.appendChild(model);
      var result = item.kind === "probe" ? (item.ok ? "ok" : "fail") : (item.outcome || "unknown");
      if (item.errorKind && item.errorKind !== "ok") result += " (" + item.errorKind + ")";
      tr.appendChild(el("td", null, result));
      tr.appendChild(el("td", "num", ms(item.latencyMs)));
      host.appendChild(tr);
    });
  }

  function render(snapshot) {
    byId("meta").textContent = "v" + snapshot.version + " · up " + duration(snapshot.uptimeMs) + " · updated " + clock(snapshot.generatedAt) + (snapshot.configPath ? " · " + snapshot.configPath : "");
    byId("meta").title = snapshot.configPath || "";
    renderSummary(snapshot);
    renderSources(snapshot.sources);
    renderAliases(snapshot.aliases);
    renderModels(snapshot.models, snapshot.aliases);
    renderHeatmap(snapshot);
    renderActivity(snapshot.recent);
  }

  function fail(error) {
    var banner = byId("error");
    banner.textContent = "dashboard refresh failed: " + error + " — retrying…";
    banner.classList.remove("hidden");
  }

  var timer = null;
  function refresh() {
    fetch("/dashboard/api/snapshot", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (snapshot) {
        byId("error").classList.add("hidden");
        render(snapshot);
        if (timer === null) {
          timer = window.setInterval(refresh, Math.max(1000, snapshot.refreshMs || 3000));
        }
      })
      .catch(function (error) {
        fail(error && error.message ? error.message : String(error));
      });
  }
  refresh();
})();
</script>
</body>
</html>
`;
}
