/**
 * Default Z.AI model list for AIRoute (flash tier — Phase 1 routes free
 * models only, so every entry below is gated `free: true` like all Phase 1
 * source models).
 *
 * LIVE-SMOKE VERIFICATION (2026-11-08, real api.z.ai calls with a real key,
 * non-stream + 200-after-retry pattern):
 * - `glm-4.5-flash` → FREE, verified working end-to-end. BUT with default
 *   settings it is a THINKING model: `max_tokens: 100` sent the entire budget
 *   to `message.reasoning_content` (`content` came back "" with
 *   finish_reason=length). With `thinking: {"type": "disabled"}` the answer
 *   arrives in `content` directly and usage drops to 30 tokens — the zai
 *   source therefore ships `thinking: "disabled"` by default (src/zai.ts).
 * - `glm-4.7-flash` → EXISTS and serves requests, but flaps with intermittent
 *   429 "The service may be temporarily overloaded, please try again later"
 *   — upstream capacity, not account quota, so the kit's existing
 *   rate_limit_error mapping stays as is. Phase 2 probes will quantify the
 *   flap rate.
 *
 * PROVEN NOT FREE / NOT SERVABLE (evidence list from the same 2026-11-08
 * smoke — kept so the next person does not re-probe them):
 * - PAID ("Insufficient balance" / "Insufficient balance or no resource
 *   package"): `glm-4.7-flashx`, `glm-4.5-air`. (The latter had been kept
 *   here as "ambiguous" before smoke — it resolved paid.)
 * - RETIRED / NONEXISTENT ("Unknown Model" error code 1211):
 *   `glm-4-flash-250414`, `glm-4-flashx-250414`, `glm-4-flash`,
 *   `glm-4-flashx`, `glm-4.6-flash`, `glm-4.6-flashx`, `glm-5-flash`.
 *
 * Context windows carry the commonly advertised 128K figure. Reasoning is
 * `false` everywhere because the Phase 1 IR does not carry reasoning/thinking
 * content yet (the kit strips `reasoning_content`; passthrough is a Phase 2
 * IR extension).
 */
import type { SourceModelDef } from "@airoute/openai-compat";

export const DEFAULT_ZAI_MODELS: readonly SourceModelDef[] = [
  {
    id: "glm-4.5-flash",
    label: "GLM-4.5 Flash",
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    aliases: [],
  },
  {
    id: "glm-4.7-flash",
    label: "GLM-4.7 Flash",
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    aliases: [],
  },
];
