/**
 * MetricsStore — SQLite persistence for AIRoute health metrics.
 *
 * Uses Node 24's built-in `node:sqlite` module (no extra dependency). The
 * database lives at `data/airoute.db` by default; `":memory:"` gives a
 * throwaway store for tests (`createInMemoryStore()`). File-backed stores
 * run in WAL mode.
 *
 * All statements are prepared once and run through positional parameters —
 * there is never a value interpolated into SQL text.
 *
 * Lookups key on (source_id, model_id) where `model_id` is the GATEWAY-level
 * model id (e.g. `"zai/glm-4.5-flash"`), matching `ModelSpec.id`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { CircuitState, ErrorKind, Outcome } from "./kinds.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** One `probe_runs` row. `ok` is stored INTEGER 0/1, surfaced as boolean. */
export interface ProbeRunRow {
  id: number;
  /** ms epoch. */
  ts: number;
  sourceId: string;
  modelId: string;
  ok: boolean;
  latencyMs: number | null;
  errorKind: ErrorKind | null;
  errorDetail: string | null;
  /** ISO timestamp string. */
  at: string;
}

/** One `request_events` row (a passive gateway signal). */
export interface RequestEventRow {
  id: number;
  ts: number;
  sourceId: string;
  modelId: string;
  outcome: Outcome;
  /** First-token latency (streaming) or `null`. */
  ttftMs: number | null;
  /** Total request wall time or `null`. */
  totalMs: number | null;
  errorKind: ErrorKind | null;
}

/** Persisted breaker row for one (sourceId, modelId). */
export interface ModelStateRow {
  sourceId: string;
  modelId: string;
  breaker: CircuitState;
  /** Consecutive failed probes (any family). */
  failureStreak: number;
  /** ms epoch of the active cooldown end, `0` = none. */
  cooldownUntil: number;
  /** ms epoch of the last state write. */
  updatedAt: number;
}

/** One `rollup_hourly` row. */
export interface RollupHourlyRow {
  id: number;
  /** ms epoch floor of the hour bucket. */
  hourStart: number;
  sourceId: string;
  modelId: string;
  probes: number;
  probeOks: number;
  requests: number;
  requestOks: number;
  /** p50 of successful-request total_ms (null when none). */
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Arguments for `recordProbe` (`latencyMs`/`errorKind`/`errorDetail`/`ts`/`at` optional). */
export interface ProbeObservation {
  sourceId: string;
  modelId: string;
  ok: boolean;
  latencyMs?: number;
  errorKind?: ErrorKind;
  errorDetail?: string;
  /** Override the recorded ms epoch; defaults to `Date.now()`. */
  ts?: number;
  /** Override the ISO `at` column; derived from `ts` when omitted. */
  at?: string;
}

/** Arguments for `recordRequest`. */
export interface RequestObservation {
  sourceId: string;
  modelId: string;
  outcome: Outcome;
  ttftMs?: number;
  totalMs?: number;
  errorKind?: ErrorKind;
  /** Override the recorded ms epoch; defaults to `Date.now()`. */
  ts?: number;
}

/** Arguments for `setBreakerState` (typed upsert). */
export interface BreakerStateUpsert {
  sourceId: string;
  modelId: string;
  breaker: CircuitState;
  failureStreak: number;
  /** ms epoch; `0` = no active cooldown. Default `0`. */
  cooldownUntil?: number;
  /** ms epoch of the write; defaults to `Date.now()`. */
  updatedAt?: number;
}

/** One aggregated statistics window for a (sourceId, modelId) pair. */
export interface StatsSnapshot {
  probes: number;
  /** `probes connected on ok / probes`; `null` when the window has no probes. */
  probeSuccessRate: number | null;
  requests: number;
  /** `requests with outcome "ok" / requests`; `null` when no requests. */
  requestSuccessRate: number | null;
  /** p50 of `total_ms` over the window's requests (null when empty). */
  p50Ms: number | null;
  p95Ms: number | null;
  /** p50 of `ttft_ms` (null when empty). */
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  /** ISO string of the newest success (probe ok or request "ok"), or null. */
  lastSuccessAt: string | null;
  /** ISO string of the newest failure (probe !ok or request outcome != "ok"), or null. */
  lastFailureAt: string | null;
  /** `error_kind` of the newest failure, falling back to its `outcome`, or null. */
  lastErrorKind: ErrorKind | Outcome | null;
}

/** Window descriptor used by `getStats` (`sourceId`, `modelId`, `windowMs`). */
export interface StatsWindow {
  sourceId: string;
  modelId: string;
  /** Rolling lookback in ms; events with `ts > now - windowMs` count. */
  windowMs: number;
}

/**
 * Aggregate the rows described by `window` (convenience destructuring helper
 * for callers that keep StatsWindow params around, e.g. the Phase 2 ranker).
 */
export function statsWindowArgs(window: StatsWindow): [string, string, number] {
  return [window.sourceId, window.modelId, window.windowMs];
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

/** Default on-disk location of the metrics database (relative to cwd). */
export const DEFAULT_METRICS_DB_PATH = "data/airoute.db";
/** Default retention horizon offered to callers of `retainOlderThan`. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const IN_MEMORY_PATH = ":memory:";

export interface MetricsStoreOptions {
  /**
   * Directory created (recursively) before opening a file-backed store.
   * Default: the file's parent directory (`data/` for the default path).
   */
  ensureParentDirectory?: boolean;
}

export class MetricsStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #stmts: {
    insertProbe: StatementSync;
    insertRequest: StatementSync;
    upsertState: StatementSync;
    stateRow: StatementSync;
    upsertRollup: StatementSync;
    rollupRows: StatementSync;
    deleteProbeRuns: StatementSync;
    deleteRequestEvents: StatementSync;
    probeWindow: StatementSync;
    requestWindow: StatementSync;
    requestLatencies: StatementSync;
    requestTtfts: StatementSync;
    lastSuccessProbe: StatementSync;
    lastSuccessRequest: StatementSync;
    lastFailureProbe: StatementSync;
    lastFailureRequest: StatementSync;
    loadAllState: StatementSync;
  };
  #closed = false;

  /**
   * Open (creating if needed) a metrics store. `filePath` may be
   * `":memory:"` for a throwaway in-memory database — see
   * {@link createInMemoryStore} for the test helper.
   *
   * File-backed stores get their parent directory created and WAL enabled.
   */
  constructor(filePath: string = DEFAULT_METRICS_DB_PATH, options: MetricsStoreOptions = {}) {
    if (filePath !== IN_MEMORY_PATH) {
      const parent = path.dirname(filePath);
      if (parent.length > 0 && options.ensureParentDirectory !== false) {
        mkdirSync(parent, { recursive: true });
      }
    }
    this.path = filePath;
    this.#db = new DatabaseSync(filePath);
    if (filePath !== IN_MEMORY_PATH) {
      this.#db.exec("PRAGMA journal_mode = WAL;");
      this.#db.exec("PRAGMA synchronous = NORMAL;");
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS probe_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        ok INTEGER NOT NULL,
        latency_ms INTEGER,
        error_kind TEXT,
        error_detail TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_probe_runs_key_ts
        ON probe_runs (source_id, model_id, ts);
      CREATE TABLE IF NOT EXISTS request_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ttft_ms INTEGER,
        total_ms INTEGER,
        error_kind TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_events_key_ts
        ON request_events (source_id, model_id, ts);
      CREATE TABLE IF NOT EXISTS model_state (
        source_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        breaker TEXT NOT NULL,
        failure_streak INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS rollup_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour_start INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        probes INTEGER NOT NULL,
        probe_oks INTEGER NOT NULL,
        requests INTEGER NOT NULL,
        request_oks INTEGER NOT NULL,
        p50_ms INTEGER,
        p95_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rollup_hourly_key
        ON rollup_hourly (hour_start, source_id, model_id);
    `);

    const db = this.#db;
    this.#stmts = {
      insertProbe: db.prepare(
        `INSERT INTO probe_runs (ts, source_id, model_id, ok, latency_ms, error_kind, error_detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertRequest: db.prepare(
        `INSERT INTO request_events (ts, source_id, model_id, outcome, ttft_ms, total_ms, error_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertState: db.prepare(
        `INSERT INTO model_state (source_id, model_id, breaker, failure_streak, cooldown_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, model_id) DO UPDATE SET
           breaker = excluded.breaker,
           failure_streak = excluded.failure_streak,
           cooldown_until = excluded.cooldown_until,
           updated_at = excluded.updated_at`,
      ),
      stateRow: db.prepare(
        `SELECT source_id, model_id, breaker, failure_streak, cooldown_until, updated_at
         FROM model_state WHERE source_id = ? AND model_id = ?`,
      ),
      loadAllState: db.prepare(
        `SELECT source_id, model_id, breaker, failure_streak, cooldown_until, updated_at
         FROM model_state`,
      ),
      upsertRollup: db.prepare(
        `INSERT INTO rollup_hourly
           (hour_start, source_id, model_id, probes, probe_oks, requests, request_oks, p50_ms, p95_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour_start, source_id, model_id) DO UPDATE SET
           probes = excluded.probes,
           probe_oks = excluded.probe_oks,
           requests = excluded.requests,
           request_oks = excluded.request_oks,
           p50_ms = excluded.p50_ms,
           p95_ms = excluded.p95_ms`,
      ),
      rollupRows: db.prepare(
        `SELECT id, hour_start, source_id, model_id, probes, probe_oks, requests, request_oks, p50_ms, p95_ms
         FROM rollup_hourly WHERE hour_start = ? ORDER BY source_id, model_id`,
      ),
      deleteProbeRuns: db.prepare(`DELETE FROM probe_runs WHERE ts < ?`),
      deleteRequestEvents: db.prepare(`DELETE FROM request_events WHERE ts < ?`),
      probeWindow: db.prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS oks
         FROM probe_runs WHERE source_id = ? AND model_id = ? AND ts > ?`,
      ),
      requestWindow: db.prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(outcome = 'ok'), 0) AS oks
         FROM request_events WHERE source_id = ? AND model_id = ? AND ts > ?`,
      ),
      requestLatencies: db.prepare(
        `SELECT total_ms FROM request_events
         WHERE source_id = ? AND model_id = ? AND ts > ? AND total_ms IS NOT NULL`,
      ),
      requestTtfts: db.prepare(
        `SELECT ttft_ms FROM request_events
         WHERE source_id = ? AND model_id = ? AND ts > ? AND ttft_ms IS NOT NULL`,
      ),
      lastSuccessProbe: db.prepare(
        `SELECT ts FROM probe_runs WHERE source_id = ? AND model_id = ? AND ok = 1
         ORDER BY ts DESC, id DESC LIMIT 1`,
      ),
      lastSuccessRequest: db.prepare(
        `SELECT ts FROM request_events WHERE source_id = ? AND model_id = ? AND outcome = 'ok'
         ORDER BY ts DESC, id DESC LIMIT 1`,
      ),
      lastFailureProbe: db.prepare(
        `SELECT ts, error_kind FROM probe_runs WHERE source_id = ? AND model_id = ? AND ok = 0
         ORDER BY ts DESC, id DESC LIMIT 1`,
      ),
      lastFailureRequest: db.prepare(
        `SELECT ts, COALESCE(error_kind, outcome) AS kind FROM request_events
         WHERE source_id = ? AND model_id = ? AND outcome != 'ok'
         ORDER BY ts DESC, id DESC LIMIT 1`,
      ),
    };
  }

  /** Whether `close()` has been called. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Append one probe observation to `probe_runs`. */
  recordProbe(observation: ProbeObservation): void {
    this.#assertOpen();
    const ts = observation.ts ?? Date.now();
    const at = observation.at ?? new Date(ts).toISOString();
    this.#stmts.insertProbe.run(
      ts,
      observation.sourceId,
      observation.modelId,
      observation.ok ? 1 : 0,
      observation.latencyMs ?? null,
      observation.errorKind ?? null,
      observation.errorDetail ?? null,
      at,
    );
  }

  /** Append one passive request signal to `request_events`. */
  recordRequest(observation: RequestObservation): void {
    this.#assertOpen();
    const ts = observation.ts ?? Date.now();
    this.#stmts.insertRequest.run(
      ts,
      observation.sourceId,
      observation.modelId,
      observation.outcome,
      observation.ttftMs ?? null,
      observation.totalMs ?? null,
      observation.errorKind ?? null,
    );
  }

  /**
   * Insert-or-update the persisted breaker row for one (sourceId, modelId).
   * Typed against {@link CircuitState} so callers (the breaker) cannot write
   * an unknown state name.
   */
  setBreakerState(upsert: BreakerStateUpsert): void {
    this.#assertOpen();
    const updatedAt = upsert.updatedAt ?? Date.now();
    this.#stmts.upsertState.run(
      upsert.sourceId,
      upsert.modelId,
      upsert.breaker,
      upsert.failureStreak,
      upsert.cooldownUntil ?? 0,
      updatedAt,
    );
  }

  /**
   * Upsert one hourly rollup keyed on (hourStart, sourceId, modelId).
   * Writes the whole row (callers aggregate first, then flush).
   */
  upsertRollup(rollup: {
    hourStart: number;
    sourceId: string;
    modelId: string;
    probes: number;
    probeOks: number;
    requests: number;
    requestOks: number;
    p50Ms?: number | null;
    p95Ms?: number | null;
  }): void {
    this.#assertOpen();
    this.#stmts.upsertRollup.run(
      rollup.hourStart,
      rollup.sourceId,
      rollup.modelId,
      rollup.probes,
      rollup.probeOks,
      rollup.requests,
      rollup.requestOks,
      rollup.p50Ms ?? null,
      rollup.p95Ms ?? null,
    );
  }

  /**
   * Delete probe-run / request-event rows strictly older than `ts` (ms epoch).
   * Returns the per-table delete counts. Callers choose the horizon (see
   * {@link DEFAULT_RETENTION_MS}); the scheduler does not call this
   * automatically — the serve boot path does.
   */
  retainOlderThan(ts: number): { probeRuns: number; requestEvents: number } {
    this.#assertOpen();
    const probeRuns = this.#stmts.deleteProbeRuns.run(ts).changes;
    const requestEvents = this.#stmts.deleteRequestEvents.run(ts).changes;
    return { probeRuns: Number(probeRuns), requestEvents: Number(requestEvents) };
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Statistics for one (sourceId, modelId) over a rolling `windowMs` lookback. */
  getStats(sourceId: string, modelId: string, windowMs: number): StatsSnapshot {
    this.#assertOpen();
    const since = Date.now() - windowMs;

    const probeRow = this.#stmts.probeWindow.get(sourceId, modelId, since) as
      | { total: number; oks: number }
      | undefined;
    const probes = Number(probeRow?.total ?? 0);
    const probeOks = Number(probeRow?.oks ?? 0);

    const requestRow = this.#stmts.requestWindow.get(sourceId, modelId, since) as
      | { total: number; oks: number }
      | undefined;
    const requests = Number(requestRow?.total ?? 0);
    const requestOks = Number(requestRow?.oks ?? 0);

    const totals = this.#numberColumn(this.#stmts.requestLatencies.all(sourceId, modelId, since), "total_ms");
    const ttfts = this.#numberColumn(this.#stmts.requestTtfts.all(sourceId, modelId, since), "ttft_ms");

    const lastSuccessProbe = this.#stmts.lastSuccessProbe.get(sourceId, modelId) as
      | { ts: number }
      | undefined;
    const lastSuccessRequest = this.#stmts.lastSuccessRequest.get(sourceId, modelId) as
      | { ts: number }
      | undefined;
    const lastFailureProbe = this.#stmts.lastFailureProbe.get(sourceId, modelId) as
      | { ts: number; error_kind: string | null }
      | undefined;
    const lastFailureRequest = this.#stmts.lastFailureRequest.get(sourceId, modelId) as
      | { ts: number; kind: string | null }
      | undefined;

    // The most recent of the two wins (whichever table has a row at all).
    const successOf = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined ? b : b === undefined ? a : Math.max(a, b);
    const succ = successOf(
      lastSuccessProbe?.ts === undefined ? undefined : Number(lastSuccessProbe.ts),
      lastSuccessRequest?.ts === undefined ? undefined : Number(lastSuccessRequest.ts),
    );

    let lastFailureAt: string | null = null;
    let lastErrorKind: ErrorKind | Outcome | null = null;
    const failureCandidates: Array<{ ts: number; kind: string | null }> = [];
    if (lastFailureProbe !== undefined) {
      failureCandidates.push({ ts: Number(lastFailureProbe.ts), kind: lastFailureProbe.error_kind });
    }
    if (lastFailureRequest !== undefined) {
      failureCandidates.push({ ts: Number(lastFailureRequest.ts), kind: lastFailureRequest.kind });
    }
    if (failureCandidates.length > 0) {
      failureCandidates.sort((a, b) => b.ts - a.ts);
      const newest = failureCandidates[0] as { ts: number; kind: string | null };
      lastFailureAt = new Date(newest.ts).toISOString();
      lastErrorKind = (newest.kind as ErrorKind | Outcome | null) ?? null;
    }

    return {
      probes,
      probeSuccessRate: probes === 0 ? null : probeOks / probes,
      requests,
      requestSuccessRate: requests === 0 ? null : requestOks / requests,
      p50Ms: percentiles(totals).p50,
      p95Ms: percentiles(totals).p95,
      ttftP50Ms: percentiles(ttfts).p50,
      ttftP95Ms: percentiles(ttfts).p95,
      lastSuccessAt: succ === undefined ? null : new Date(succ).toISOString(),
      lastFailureAt,
      lastErrorKind,
    };
  }

  /** Persisted breaker row for one pair, or `undefined` when never written. */
  getBreakerState(sourceId: string, modelId: string): ModelStateRow | undefined {
    this.#assertOpen();
    const row = this.#stmts.stateRow.get(sourceId, modelId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toModelStateRow(row);
  }

  /** All persisted breaker rows (used by `HealthTracker` to restore state). */
  getBreakerStates(): ModelStateRow[] {
    this.#assertOpen();
    const rows = this.#stmts.loadAllState.all() as Array<Record<string, unknown>>;
    return rows.map(toModelStateRow);
  }

  /** All rollup rows for one `hourStart` bucket, ordered by source/model. */
  getRollups(hourStart: number): RollupHourlyRow[] {
    this.#assertOpen();
    const rows = this.#stmts.rollupRows.all(hourStart) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row["id"]),
      hourStart: Number(row["hour_start"]),
      sourceId: String(row["source_id"]),
      modelId: String(row["model_id"]),
      probes: Number(row["probes"]),
      probeOks: Number(row["probe_oks"]),
      requests: Number(row["requests"]),
      requestOks: Number(row["request_oks"]),
      p50Ms: row["p50_ms"] === null ? null : Number(row["p50_ms"]),
      p95Ms: row["p95_ms"] === null ? null : Number(row["p95_ms"]),
    }));
  }

  /** Test/diagnostic helper: all `probe_runs` rows for one pair, newest first. */
  probeRunsFor(sourceId: string, modelId: string, limit = 100): ProbeRunRow[] {
    this.#assertOpen();
    const stmt = this.#db.prepare(
      `SELECT id, ts, source_id, model_id, ok, latency_ms, error_kind, error_detail, at
       FROM probe_runs WHERE source_id = ? AND model_id = ?
       ORDER BY ts DESC, id DESC LIMIT ?`,
    );
    const rows = stmt.all(sourceId, modelId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row["id"]),
      ts: Number(row["ts"]),
      sourceId: String(row["source_id"]),
      modelId: String(row["model_id"]),
      ok: Number(row["ok"]) === 1,
      latencyMs: row["latency_ms"] === null ? null : Number(row["latency_ms"]),
      errorKind: (row["error_kind"] as ErrorKind | null) ?? null,
      errorDetail: (row["error_detail"] as string | null) ?? null,
      at: String(row["at"]),
    }));
  }

  /** Close the database handle. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  #assertOpen(): void {
    if (this.#closed) throw new Error("MetricsStore is closed");
  }

  #numberColumn(
    rows: Array<Record<string, unknown>>,
    column: string,
  ): number[] {
    return rows
      .map((row) => row[column])
      .filter((value): value is number => typeof value === "number")
      .map((value) => Number(value));
  }
}

/** Percentile helper (nearest-rank): `p50`/`p95` of a numeric list, null when empty. */
export function percentiles(values: readonly number[]): { p50: number | null; p95: number | null } {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
    return sorted[index] as number;
  };
  return { p50: at(0.5), p95: at(0.95) };
}

function toModelStateRow(row: Record<string, unknown>): ModelStateRow {
  return {
    sourceId: String(row["source_id"]),
    modelId: String(row["model_id"]),
    breaker: row["breaker"] as CircuitState,
    failureStreak: Number(row["failure_streak"]),
    cooldownUntil: Number(row["cooldown_until"]),
    updatedAt: Number(row["updated_at"]),
  };
}

/** In-memory store factory for tests (`createInMemoryStore()` in `":memory:"`). */
export function createInMemoryStore(file?: string): MetricsStore {
  return new MetricsStore(file ?? IN_MEMORY_PATH);
}
