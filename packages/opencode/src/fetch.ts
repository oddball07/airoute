/**
 * Gateway catalog fetching for the OpenCode integration (Phase 3).
 *
 * `install-opencode --url URL` uses this instead of the local source registry
 * so the install works against a remote airoute gateway too.
 */
import type { ModelSpec } from "@airoute/core";
import { gatewayCatalogToSpecs, normalizeGatewayBaseUrl } from "./config.js";
import { isRecord } from "./jsonc.js";

/** What `install-opencode --url` needs: the free catalog plus alias names. */
export interface GatewayCatalog {
  specs: ModelSpec[];
  /** Alias names declared by the gateway (empty when the payload has none). */
  aliases: string[];
}

/**
 * GET `<baseUrl>/v1/models` and parse the response into free-only `ModelSpec`s
 * plus the gateway's alias names. Throws on transport errors, non-2xx
 * responses, unparseable bodies, or a malformed catalog payload.
 */
export async function fetchGatewayCatalog(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayCatalog> {
  const url = `${normalizeGatewayBaseUrl(baseUrl)}/models`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gateway catalog: GET ${url} failed: ${message}`);
  }
  if (!response.ok) {
    throw new Error(`gateway catalog: GET ${url} returned HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gateway catalog: GET ${url} returned an unparseable body: ${message}`);
  }
  return { specs: gatewayCatalogToSpecs(payload), aliases: parseGatewayAliases(payload) };
}

/** Alias names from a `/v1/models` payload; non-arrays and bad entries are ignored. */
function parseGatewayAliases(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const raw = payload["aliases"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && value.length > 0);
}
