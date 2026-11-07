/**
 * Default Z.AI model list for AIRoute (flash tier — Phase 1 routes free
 * models only, so every entry below is gated `free: true` like all Phase 1
 * source models).
 *
 * FREE-STATUS NOTE — verify free status at live smoke after keys arrive:
 * - `glm-4.5-flash`, `glm-4-flash-250414`, `glm-4-flashx-250414` are
 *   advertised as free-tier models on Z.AI / open.bigmodel.cn docs.
 * - `glm-4.5-air` is AMBIGUOUS: it appears in some free-tier listings but is
 *   documented as a paid-tier model. Kept here deliberately (flash-tier
 *   defaults only) and clearly flagged — confirm its free status before
 *   trusting it in an alias bucket.
 *
 * Context windows carry the commonly advertised 128K figure; verify at live
 * smoke. Reasoning is `false` everywhere because the Phase 1 IR does not
 * carry reasoning/thinking content yet.
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
    id: "glm-4-flash-250414",
    label: "GLM-4 Flash (250414)",
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    aliases: [],
  },
  {
    id: "glm-4-flashx-250414",
    label: "GLM-4 FlashX (250414)",
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    aliases: [],
  },
  {
    // AMBIGUOUS free status: verify at live smoke after keys arrive.
    id: "glm-4.5-air",
    label: "GLM-4.5 Air",
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    aliases: [],
  },
];
