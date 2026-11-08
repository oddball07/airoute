/**
 * Outcome / error-kind vocabularies shared by the metrics store, the probe
 * scheduler and the circuit breaker.
 *
 * `Outcome` is the passive signal the gateway records for every request
 * (Phase 2 part 2 wires it). `ErrorKind` is the normalized failure family —
 * probes produce free-text error strings (e.g. ProbeResult.error), requests
 * produce an `Outcome`; both collapse onto `ErrorKind` so the breaker and the
 * ranker can treat equivalent failures the same way.
 */

/**
 * Passive/active traffic outcome. Recorded verbatim in `request_events.outcome`.
 *
 * `drop` = the *client* hung up (abort/disconnect). It is deliberately
 * neutral for the breaker: it says nothing about model health.
 */
export type Outcome =
  | "ok"
  | "rate_limited"
  | "capacity"
  | "server"
  | "timeout"
  | "network"
  | "drop"
  | "auth";

/**
 * Normalized failure family. `probe_runs.error_kind` / `request_events.error_kind`
 * store this. `classifyError` maps arbitrary upstream error text onto it.
 */
export type ErrorKind = Exclude<Outcome, "ok" | "drop"> | "unknown";

/**
 * Map a source error string (or thrown error) onto an `ErrorKind`.
 *
 * Inputs are live-observed strings from the Phase 1 sources — the compat kit
 * produces short labels ("`rate_limited`", "`timeout`", "`network_error`",
 * "`http_<status>`") plus provider detail text; the scheduler passes the
 * short labels, the breaker sees both. Matching is done on the lower-cased
 * whole string, first match wins:
 *
 * 1. `overloaded`                       → "capacity" — ZAI free tier flaps
 *    (verified live 2026-11-08): glm-4.7-flash intermittently 429s with
 *    "The service may be temporarily overloaded". That is upstream
 *    *capacity*, not your account's rate limit; clusters with 429s for
 *    cooldown purposes but must not be mistaken for a quota problem.
 * 2. `provider returned error`          → "server" — OpenRouter dead/degraded
 *    upstream models surface as 429 "Provider returned error"; the right
 *    reaction is a server-family failure (line up for the streak → down
 *    path), not rate-limit cooldown, so dead models leave the pool.
 * 3. `rate_l` (rate_limited / rate_limit_exceeded / rate_limit_error)
 *    → "rate_limited" — real 429 shaping from the provider.
 * 4. `timeout` / `timed out` / "did not respond within…" / "idle for more
 *    than…" → "timeout".
 * 5. `network_error` / `fetch failed` / `econn…` / `enotfound` / `eai_again` → "network".
 * 6. `insufficient` / `balance` / `quota` / `invalid_api_key` → "auth" —
 *    key or quota problems (verified live against OpenRouter: "Insufficient
 *    balance or no resource package"). Not transient traffic problems.
 * 7. `http_<status>` — status decides: 429 → "rate_limited", 401/403/407 →
 *    "auth", 504 → "timeout", anything else → "server".
 * 8. otherwise "unknown".
 *
 * "overloaded" outranks "rate_l" (a ZAI 429 whose detail says "temporarily
 * overloaded" is capacity); "provider returned error" outranks "rate_l"
 * (an OpenRouter 429 naming a dead upstream is a server failure).
 */
export function classifyError(errOrMessage?: string | unknown): ErrorKind {
  if (errOrMessage === undefined || errOrMessage === null) return "unknown";
  let message: string;
  if (typeof errOrMessage === "string") {
    message = errOrMessage;
  } else if (typeof errOrMessage === "object" && errOrMessage instanceof Error) {
    message = errOrMessage.message;
  } else if (typeof errOrMessage === "object") {
    // Best-effort: pick a string-ish field chain (`{ error: "…" }` shapes).
    const record = errOrMessage as Record<string, unknown>;
    const candidate =
      record["error"] ?? record["message"] ?? record["detail"] ?? record["code"];
    if (typeof candidate === "string") return classifyError(candidate);
    return "unknown";
  } else {
    message = String(errOrMessage);
  }

  const lower = message.toLowerCase();

  if (lower.includes("overloaded")) return "capacity";
  if (lower.includes("provider returned error")) return "server";
  if (lower.includes("rate_l")) return "rate_limited";
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("did not respond") ||
    lower.includes("did not complete") ||
    lower.includes("idle for more than")
  ) {
    return "timeout";
  }
  if (
    lower.includes("network_error") ||
    lower.includes("fetch failed") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("econnrefused")
  ) {
    return "network";
  }
  if (
    lower.includes("insufficient") ||
    lower.includes("balance") ||
    lower.includes("quota") ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid api key")
  ) {
    return "auth";
  }
  const httpMatch = /http_?(\d{3})/.exec(lower);
  if (httpMatch !== null) {
    const status = Number(httpMatch[1]);
    if (status === 429) return "rate_limited";
    if (status === 401 || status === 403 || status === 407) return "auth";
    if (status === 504) return "timeout";
    return "server";
  }
  return "unknown";
}

/**
 * Map an already-typed request `Outcome` onto the `ErrorKind` the breaker
 * logic consumes. `ok`/`drop` never reach this (the breaker treats them
 * separately); it exists so an `outcome` alone (no `errorKind` given) still
 * classifies deterministically.
 */
export function outcomeToErrorKind(outcome: Exclude<Outcome, "ok" | "drop">): ErrorKind {
  return outcome;
}

/** Circuit breaker states, in health order. */
export type CircuitState = "healthy" | "degraded" | "cooling" | "down";
