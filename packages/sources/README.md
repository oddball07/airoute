# packages/sources

Source plugins (AI providers) live here. Each is a workspace package under
`packages/sources/<name>` with package name `@airoute/sources/<name>` and a
default export factory `(entry) => Source` implementing the `Source` interface
from `@airoute/core`.

At the moment this directory is intentionally empty: Phase 0 ships only the
`mock` source used in tests (see `e2e/mock-provider`), plus stub registry
entries for `zai` and `openrouter` in `config/airoute.json` (both disabled).
