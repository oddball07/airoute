# Free AI provider shortlist (Phase 8 research)

> Verified against provider docs on **2026-11-09**. Free tiers churn: re-check
> pricing/limits before implementing a source. AIRoute's rule is **free models
> only** — a provider that is "free for 30 days" or requires prepaid credits is
> not a default-eligible source.

Scope: providers that can feed `@airoute/sources` through an HTTP API. One
`Source` package per provider; most speak OpenAI Chat Completions, so the
`openai-compat` kit does the heavy lifting. WebSource (Phase 6) stays skipped.

## Tier 1 — integrate first (permanent free tier, good coding models)

| Provider | OpenAI-compatible base URL | Free allowance | Notable free models | Friction |
| --- | --- | --- | --- | --- |
| **Google Gemini** (AI Studio) | `https://generativelanguage.googleapis.com/v1beta/openai/` | Free input/output on `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` | Gemini 3.8 Flash (agentic/coding), Flash-Lite (fast) | No card; free-tier prompts are used to improve Google products; 3.1 Pro / Gemini 4 are paid |
| **Groq** | `https://api.groq.com/openai/v1` | 30 RPM, 1,000 RPD, 8K TPM, 200K TPD (gpt-oss / Qwen) | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | No card; low TPM but very fast; tools supported |
| **Cloudflare Workers AI** | `https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1` | 10,000 Neurons/day (resets 00:00 UTC) | `@cf/openai/gpt-oss-120b`, `@cf/qwen/qwen3.8-27b`, `@cf/zai-org/glm-4.7-flash`, Llama/Gemma/Mistral | Free plan only; Kimi/GLM-5.x/DeepSeek frontier models require Workers Paid |
| **NVIDIA NIM** (build.nvidia.com) | `https://integrate.api.nvidia.com/v1` | Dev tier ~40 RPM, ~1,000 credits (reported) | `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`, `nemotron-3.5-lightning-30b-a3b`, many open models | Account/phone verification; credit-metered "free", dev/test only — label it optional, not permanent |

Why these four: Gemini and Groq are the best free coding models right now;
Cloudflare adds GLM/Qwen/GPT-OSS breadth on one key; NVIDIA adds the largest
open-model catalog but is credit-based, so it should not be the default route
once credits run out.

## Tier 2 — worth adding, with caveats

| Provider | Base URL | Free allowance | Caveats |
| --- | --- | --- | --- |
| **Mistral La Plateforme** | `https://api.mistral.ai/v1` | Experiment tier: ~1 req/s, ~1B tokens/month, all API models (Mistral Large, Codestral) | Phone verification; free-tier data used for training; console shows per-workspace limits — verify the Experiment plan still exists for the account |
| **ModelScope API-Inference** | `https://api-inference.modelscope.cn/v1` | Daily "Magicubes": 200/day sign-in + 50/day linked Alibaba Cloud; calls cost 0.5–2 | Requires Alibaba Cloud real-name (ID) verification; explicitly non-commercial/eval; Qwen 3.8/3.5 family |
| **SiliconFlow** | `https://api.siliconflow.cn/v1` (global: `api.siliconflow.com/v1`) | Selected small models billed at zero with fixed low limits; $1/¥16 new-user credit | Identity verification; free models are small (Qwen3-8B class); good as low-weight fallback only |
| **SambaNova Cloud** | `https://api.sambanova.ai/v1` | 20 RPM, **20 RPD**, 200K TPD per model | 20 requests/day is not agent-grade; keep only as a last-resort watchdog |
| **xAI (Grok)** | `https://api.x.ai/v1` | $25 signup credits (30 days) + $150/month data-sharing credits after $5 spend | Not a permanent free tier; data-sharing means prompts are training data; card/eligibility rules apply |
| **Vercel AI Gateway** | `https://ai-gateway.vercel.sh/v1` | Free-tier model subset + monthly included credit, per-model rate limits | Free catalog is a subset and limits are not published; multi-provider credit, not a free model list |
| **Cohere** | `https://api.cohere.ai/compatibility/v1` | Trial key: ~1,000 calls/month, 20 RPM | Non-commercial; command models, low volume — not a primary coding source |

## Already connected

- **Z.AI** — GLM-4.5/4.7 Flash free tier.
- **OpenRouter** — 25+ `:free` models, 20 RPM, 50 RPD (1,000 RPD after $10 of
  credits). Best breadth today; failed attempts count against the daily cap.

## Do not integrate (checked 2026-11-09)

| Provider | Why not |
| --- | --- |
| **GitHub Models** | Fully retired 2026-07-30 (catalog, inference, BYOK gone) |
| **Cerebras** | No permanent free tier: $5 trial credit, expires 30 days, payment method required |
| **Hugging Face Inference Providers** | Free accounts get no monthly credits (PRO gets $2) |
| **Chutes** | Pay-per-token only in the current pricing page |
| **OVH AI Endpoints** | LLM catalog is paid; only some non-LLM endpoints are free |
| **Together / Fireworks / DeepInfra** | Trial credits only, not a lasting free tier |

## Integration notes

1. **One package per provider**: `packages/sources/gemini`,
   `sources/groq`, `sources/cloudflare`, `sources/nvidia`, … Reuse
   `@airoute/sources/openai-compat` for request building and SSE parsing.
2. **Free-only gate at the source**, not the gateway: each source's static
   catalog must list only free-eligible model ids. Gemini must exclude
   `gemini-3.1-pro-preview`/Gemini 4; Cloudflare must exclude paid-only
   Kimi/GLM-5.x/DeepSeek-V4-Pro; Groq's free list is the source list.
3. **Env keys** (never logged): `GEMINI_API_KEY`, `GROQ_API_KEY`,
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `NVIDIA_API_KEY`,
   `MISTRAL_API_KEY`, `MODELSCOPE_API_KEY`, `SILICONFLOW_API_KEY`,
   `SAMBANOVA_API_KEY`, `XAI_API_KEY`.
4. **Probe budget**: adding ~30 models multiplies probe traffic. Gate every new
   source behind a per-source probe cap/concurrency limit (Phase 8 item 4)
   before enabling them together.
5. **Capability metadata**: set `caps.tools` only where the provider documents
   OpenAI-style function calling (Gemini, Groq, Mistral, NVIDIA mostly yes;
   Cloudflare varies by model — check each). Wrong `tools: true` metadata
   breaks agent routing.
6. **Data policy**: free tiers at Google/Mistral/xAI train on prompts. Do not
   route sensitive code through them without the user explicitly opting in.
7. **Tooling**: the Phase 8 e2e suite should include at least one non-OpenRouter
   source so failover is tested across providers, not just across models.

## Sources

- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- Groq rate limits: https://console.groq.com/docs/rate-limits
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare OpenAI compatibility: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- NVIDIA NIM: https://build.nvidia.com/
- Mistral usage/limits: https://docs.mistral.ai/admin/billing-usage/usage-limits
- ModelScope API-Inference limits: https://www.modelscope.ai/docs/model-service/API-Inference/limits
- SiliconFlow: https://www.siliconflow.com/
- SambaNova rate limits: https://docs.sambanova.ai/docs/en/models/rate-limits
- xAI data sharing: https://docs.x.ai/docs/data-sharing
- Vercel AI Gateway pricing: https://vercel.com/docs/ai-gateway/pricing
- GitHub Models retirement: https://docs.github.com/en/github-models/about-github-models
- Cerebras rate limits / trial: https://inference-docs.cerebras.ai/support/rate-limits
