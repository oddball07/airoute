# @airoute/opencode

Phase 3 OpenCode integration for AIRoute: builds and installs an OpenCode
custom-provider config (V2 `package`-based provider) pointing at the local
AIRoute gateway (`http://127.0.0.1:8787/v1`). Free models only — a payload with
`free !== true` is rejected before anything is written.

## What it does

- Reads the existing OpenCode config (global `~/.config/opencode/opencode.json`
  honoring `XDG_CONFIG_HOME`, or `<dir>/opencode.json`); JSONC comments and
  trailing commas are supported on read (they are rewritten as plain JSON).
- Fetches the free catalog either from a running gateway (`/v1/models`) or from
  the local AIRoute config + source registry.
- Replaces `providers.airoute` wholesale (idempotent), preserves every other
  top-level key and other providers, and only sets `model` when the existing
  config has none.
- Writes atomically (temp sibling + rename) after backing the previous file up
  to `<path>.bak`. Identical content is left untouched (`changed: false`).

## Quick start

```bash
airoute install-opencode                 # write the global OpenCode config
airoute install-opencode --project .     # write <cwd>/opencode.json
airoute install-opencode --dry-run       # print the rendered JSON, write nothing
```

```ts
import { installOpencode } from "@airoute/opencode";

const result = await installOpencode({
  configPath: await globalOpencodeConfigPath(),
  specs,
  aliases: Object.keys(config.aliases),
  gatewayUrl: "http://127.0.0.1:8787",
});
```

Then inside OpenCode: `opencode models` and
`opencode run --model airoute/free-best "hi"`.
