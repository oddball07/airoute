/**
 * Install/write the OpenCode provider config (Phase 3).
 *
 * Safety properties:
 * - Existing configs are parsed as JSONC, must be JSON objects, and every
 *   unrelated key/provider is preserved by `buildOpencodeConfig`.
 * - Writes are atomic: the previous file is copied to `<path>.bak`, then a
 *   temp sibling is written and renamed over the target.
 * - Identical content is a no-op (`changed: false`, no .bak churn).
 * - `dryRun` never touches the filesystem.
 * - Free models only: `buildOpencodeConfig` throws on any `free !== true` spec.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelSpec } from "@airoute/core";
import { buildOpencodeConfig, type BuildOpencodeConfigOptions } from "./config.js";
import { isRecord, parseJsonc } from "./jsonc.js";

export interface InstallOpencodeOptions extends BuildOpencodeConfigOptions {
  /** Absolute or relative path of the OpenCode config file to write. */
  configPath: string;
  /** Render and report without touching the filesystem. */
  dryRun?: boolean;
}

export interface InstallOpencodeResult {
  /** Target config path (as given). */
  path: string;
  /** The target file did not exist before this install. */
  created: boolean;
  /** Content differed from the existing file (or the file was created). */
  changed: boolean;
  /** Free models written into the airoute provider block. */
  modelCount: number;
  /** Set only when the previous file was copied to `<path>.bak`. */
  backupPath?: string;
  /** The rendered (2-space JSON) config content. */
  content: string;
}

/**
 * Read the config at `configPath` (missing = create), merge the AIRoute
 * provider block in, and atomically write the result. Returns what happened.
 */
export async function installOpencode(
  options: InstallOpencodeOptions,
): Promise<InstallOpencodeResult> {
  const { configPath, dryRun = false } = options;

  let existed = false;
  let raw: string | undefined;
  try {
    raw = await readFile(configPath, "utf8");
    existed = true;
  } catch (err) {
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      throw err;
    }
  }

  let existing: unknown;
  if (raw !== undefined) {
    existing = parseJsonc(raw);
    if (!isRecord(existing)) {
      throw new Error(`${configPath}: OpenCode config must be a JSON object`);
    }
  }

  const config = buildOpencodeConfig(existing, options);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  const changed = raw === undefined || content !== raw;
  const modelCount = countFreeModels(options.specs);

  if (dryRun) {
    return {
      path: configPath,
      created: !existed,
      changed,
      modelCount,
      content,
    };
  }
  if (!changed) {
    return {
      path: configPath,
      created: false,
      changed: false,
      modelCount,
      content,
    };
  }

  const target = path.resolve(configPath);
  await mkdir(path.dirname(target), { recursive: true });

  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${configPath}.bak`;
    // Overwrite any stale .bak from a previous install.
    await copyFile(configPath, backupPath);
  }

  // Atomic replace: write a temp sibling, then rename over the target.
  const tempPath = `${configPath}.tmp-${process.pid}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, configPath);

  return {
    path: configPath,
    created: !existed,
    changed: true,
    modelCount,
    backupPath,
    content,
  };
}

function countFreeModels(specs: readonly ModelSpec[]): number {
  let count = 0;
  for (const spec of specs) {
    if (spec.free === true) count++;
  }
  return count;
}
