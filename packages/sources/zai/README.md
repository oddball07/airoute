# @airoute/zai

Z.AI (Zhipu AI — api.z.ai / open.bigmodel.cn) source plugin for AIRoute,
built on the shared `@airoute/openai-compat` kit.

## Config entry

In `config/airoute.json` (`sources.registry`), all options optional:

```json
{ "type": "zai", "enabled": true, "baseUrl": "https://api.z.ai/api/paas/v4", "timeoutMs": 60000, "models": [{ "id": "glm-4.5-flash", "label": "GLM-4.5 Flash", "contextWindow": 128000, "caps": { "tools": true }, "aliases": [] }] }
```

- `baseUrl` — override `DEFAULT_ZAI_BASE_URL` (`https://api.z.ai/api/paas/v4`).
- `models` — replaces the default `DEFAULT_ZAI_MODELS` list entirely.
- `timeoutMs` — idle timeout (default 60 s), see the kit README.

Malformed options throw `ConfigError` naming the offending option, which
`buildRegistry` reports as a skipped-source warning (never a crash).

## Key handling

The key comes from the `ZAI_API_KEY` environment variable (`SOURCE_ENV_KEYS`
already maps `zai → ZAI_API_KEY`). Without it, the source self-skips at
startup with:

```
source 'zai' disabled: no key (ZAI_API_KEY is not set)
```

Keys are read from the environment only — never from config, never logged.

## Default models (flash tier)

`glm-4.5-flash`, `glm-4-flash-250414`, `glm-4-flashx-250414`, and
`glm-4.5-air`. All gated `free: true` (Phase 1 is free-only). Verify free
status at live smoke after keys arrive — `glm-4.5-air`'s is ambiguous; see the
comment in `src/models.ts`. Context windows assume the advertised 128K.

## Factory exports

- `createZaiSourceFactory(entry: SourceConfigEntry): Source` — the `SourceFactory`
  wired into `packages/cli/src/cli.ts` under the `"zai"` type.
- `createZaiSource(options?: ZaiSourceOptions): Source` — direct constructor
  for tests (`baseUrl`, `apiKey`, `fetch`, … overrides).
- `DEFAULT_ZAI_MODELS`, `DEFAULT_ZAI_BASE_URL`, `DEFAULT_ZAI_SOURCE_ID`, `ZAI_ENV_KEY`.
