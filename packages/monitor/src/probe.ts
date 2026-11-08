/**
 * `probeOne` — race a single `source.probe()` call against a timeout and
 * always land on a `ProbeResult` (never rejects).
 *
 * The util is standalone from the scheduler so tests and Part 2 wiring can
 * use it for one-off manual/refresh probes.
 */
import type { ModelSpec, ProbeResult, Source } from "@airoute/core";

/** Default per-probe timeout. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Run `source.probe(model)`; on timeout return
 * `{ ok: false, latencyMs: timeoutMs, error: "timeout", at }` instead of
 * waiting/hanging. A probe that *rejects* (the contract says it must not,
 * but defensive) maps to `error: "probe_failed"`.
 *
 * Note: timing uses real `Date.now()`/`setTimeout` regardless of any
 * scheduler-provided clock — the timeout loser's timer is `unref()`-ed so
 * short-lived processes and tests never hang on it.
 */
export async function probeOne(
  source: Source,
  model: ModelSpec,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeoutResult = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        latencyMs: timeoutMs,
        error: "timeout",
        at: new Date().toISOString(),
      });
    }, timeoutMs);
    timer.unref();
  });

  const probeResult = source
    .probe(model)
    .catch(
      (err: unknown): ProbeResult => ({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: "probe_failed",
        at: new Date().toISOString(),
      }),
    )
    .then((result: ProbeResult): ProbeResult => {
      if (timer !== undefined) clearTimeout(timer);
      return result;
    });

  // When the timeout wins, the probe promise stays pending; its eventual
  // resolution clears the (already fired) timer and is discarded safely —
  // the chain above never rejects, so there is nothing unhandled.
  return Promise.race([timeoutResult, probeResult]);
}
