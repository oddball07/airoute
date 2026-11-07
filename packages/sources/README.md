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

Still to come: `openrouter` — the type name is already reserved in
`KNOWN_SOURCE_TYPES` / the config schema / `SOURCE_ENV_KEYS`, and the CLI
factory map in `packages/cli/src/cli.ts` marks its wiring spot. Build it on
`openai-compat` the same way `zai` is.
