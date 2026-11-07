# @airoute/openrouter

OpenRouter source plugin for AIRoute, built on the shared
`@airoute/openai-compat` kit. Unlike the static-list `zai` wrapper, OpenRouter's
model catalog is DYNAMIC — the default path fetches it live and keeps only the
free models (Phase 1 is free-only). Streaming, probing, and completion are
fully delegated to the kit (SSE semantics, error mapping, the
`x-airoute-probe: 1` probe header, never logging keys — see the kit README).

## Config entry

In `config/airoute.json` (`sources.registry`), all options optional:

```json
{
  "type": "openrouter",
  "enabled": true,
  "baseUrl": "https://openrouter.ai/api/v1",
  "models": [{ "id": "deepseek/deepseek-chat-v3.1:free", "label": "DeepSeek V3.1 (free)", "contextWindow": 163840, "caps": { "tools": true } }],
  "maxModels": 500,
  "allow": ["deepseek"],
  "disallow": [".*:long-context.*"],
  "catalogTimeoutMs": 10000,
  "title": "AIRoute",
  "referer": "",
  "timeoutMs": 60000
}
```

- `baseUrl` — override `DEFAULT_OPENROUTER_BASE_URL`
  (`https://openrouter.ai/api/v1`).
- `models` — a STATIC `SourceModelDef` list that REPLACES catalog fetching
  entirely (offline use, tests). When unset, the live catalog is used.
- `maxModels` — cap on the catalog after filtering (taken in alphabetical
  order), default 500; `0` = uncapped. Ignored with a static `models` list.
- `allow` / `disallow` — arrays of id patterns; each pattern matches an
  OpenRouter model id as a substring or as a regex source (`"deepseek"` or
  `".*:free$"`). `allow` keeps the matches, then `disallow` drops matches.
  Matched against both the raw provider id and the gateway id
  (`openrouter/<provider-id>`). Only applied to the live catalog.
- `catalogTimeoutMs` — whole-request timeout for the catalog GET, default 10 s.
- `title` / `referer` — OpenRouter app attribution, sent as `X-Title`
  (default `AIRoute`) and `HTTP-Referer` (default empty → header omitted) on
  catalog and chat calls.

Malformed options throw `ConfigError` naming the offending option, which
`buildRegistry` reports as a skipped-source warning (never a crash).

## Catalog → ModelSpec mapping

`GET ${baseUrl}/models` is a public OpenRouter endpoint; failures surface as
`UpstreamError` (`network_error`, `http_<status>`, `upstream_error`), which the
registry's aggregation turns into a warn + source skip. Each free entry maps:

- kept iff its id ends with `":free"` OR both `pricing.prompt` and
  `pricing.completion` are exactly `"0"` (paid entries dropped silently;
  entries without a usable id warn-skipped; a weird entry never throws).
- `id`: `"openrouter/<data.id>"` (sourceId `"openrouter"`)
- `label`: `data.name`
- `contextWindow`: `context_length` → `top_provider.context_length` → `0`
- `caps`: `tools` = `supported_parameters` includes `"tools"`;
  `vision` = `architecture.input_modalities` includes `"image"`;
  `reasoning` = includes `"reasoning"` or `"include_reasoning"`
  (OpenRouter has used both names — both are tolerated).
- ordering: alphabetical for determinism, then `allow` → `disallow` →
  `maxModels`.

## Key handling

The key comes from the `OPENROUTER_API_KEY` environment variable
(`SOURCE_ENV_KEYS` already maps `openrouter → OPENROUTER_API_KEY`). Without
it, the source self-skips at startup with:

```
source 'openrouter' disabled: no key (OPENROUTER_API_KEY is not set)
```

Keys are read from the environment only — never from config, never logged.

## Factory exports

- `createOpenRouterSourceFactory(entry: SourceConfigEntry): Source` — the
  `SourceFactory` wired into `packages/cli/src/cli.ts` under the
  `"openrouter"` type.
- `createOpenRouterSource(options?: OpenRouterSourceOptions): OpenAICompatSource`
  — direct constructor for tests (`baseUrl`, `apiKey`, `models`, `fetch`, …
  overrides); also exposes the kit's `complete()` path.
- `DEFAULT_OPENROUTER_BASE_URL`, `DEFAULT_OPENROUTER_SOURCE_ID`,
  `DEFAULT_OPENROUTER_TITLE`, `DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS`,
  `DEFAULT_OPENROUTER_MAX_MODELS`, `OPENROUTER_ENV_KEY`; plus the catalog
  helpers (`loadCatalogModels`, `mapCatalogEntry`, `filterCatalogSpecs`,
  `isFreeCatalogEntry`, `openRouterAttributionHeaders`) and validators
  (`validatePatternList`, `validateMaxModels`,
  `validateAttributionString`) from `catalog.ts`.
