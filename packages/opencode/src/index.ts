/**
 * AIRoute ↔ OpenCode integration (Phase 3).
 *
 * Builds and installs an OpenCode custom-provider config pointing at the local
 * free-model gateway. Public surface of `@airoute/opencode`.
 */
export {
  AIROUTE_PROVIDER_ID,
  DEFAULT_OPENCODE_MODEL,
  buildAirouteProvider,
  buildOpencodeConfig,
  gatewayCatalogToSpecs,
  normalizeGatewayBaseUrl,
  opencodeSchema,
  type BuildOpencodeConfigOptions,
} from "./config.js";
export { fetchGatewayCatalog } from "./fetch.js";
export { isRecord, parseJsonc } from "./jsonc.js";
export {
  globalOpencodeConfigPath,
  projectOpencodeConfigPath,
} from "./paths.js";
export {
  installOpencode,
  type InstallOpencodeOptions,
  type InstallOpencodeResult,
} from "./install.js";
