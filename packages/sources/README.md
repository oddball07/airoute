# packages/sources

Source plugins (AI providers) live here. Each is a workspace package under
`packages/sources/<name>` with package name `@airoute/<name>` (npm scopes allow
a single segment, so the package name is flattened from the directory layout —
same convention as `@airoute/mock-provider`) and a
factory `(entry) => Source` implementing the `Source` interface from
`@airoute/core`.

Currently landed:

| Package | What it is |
| --- | --- |
| `openai-compat` | Shared kit for OpenAI-compatible providers (SSE → IR streaming, probe, non-stream `complete()`, offline-testable via fetch injection). See its README for the contract and exported API. |
| `zai` | Z.AI (Zhipu AI) plugin built on `openai-compat`; wired into the CLI under the `"zai"` type, enabled in `config/airoute.json`, self-skips without `ZAI_API_KEY`. |
| `openrouter` | OpenRouter free-model plugin built on `openai-compat`; wired into the CLI under the `"openrouter"` type, enabled in `config/airoute.json`, self-skips without `OPENROUTER_API_KEY`. Fetches the live `GET /models` catalog (free filter → sort → `allow`/`disallow` → `maxModels` cap) or uses a static `models` override. |

Next up (Phase 2): the sources gain the health-monitor hooks the ranker will
consume; config alias candidates are then ranked by `rank.weights` instead of
tried in declaration order.
