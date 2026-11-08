import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSpec } from "@airoute/core";
import { installOpencode } from "@airoute/opencode";
import { afterAll, describe, expect, it } from "vitest";

let dir: string | undefined;

async function tempDir(): Promise<string> {
  dir = dir ?? (await mkdtemp(path.join(tmpdir(), "airoute-opencode-")));
  return dir;
}

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

function spec(id = "zai/glm-4.5-flash"): ModelSpec {
  return {
    id,
    sourceId: "zai",
    sourceModelId: id.replace("zai/", ""),
    label: "GLM-4.5-Flash",
    contextWindow: 128000,
    caps: { tools: true, vision: false, reasoning: true },
    free: true,
    aliases: [],
  };
}

const OPTIONS = { specs: [spec()], aliases: ["free-best"], gatewayUrl: "http://127.0.0.1:8787" };

describe("installOpencode", () => {
  it("creates a fresh, valid JSON config with an idempotent rerun", async () => {
    const root = await tempDir();
    const file = path.join(root, "opencode.json");

    const first = await installOpencode({ configPath: file, ...OPTIONS });
    expect(first.created).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.modelCount).toBe(1);
    expect(first.backupPath).toBeUndefined();

    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      $schema: string;
      model: string;
      providers: Record<string, unknown>;
    };
    expect(parsed["$schema"]).toBe("https://opencode.ai/config.json");
    expect(parsed.model).toBe("airoute/free-best");
    expect(Object.keys(parsed.providers)).toEqual(["airoute"]);

    // Second install: unchanged, no backup churn.
    const second = await installOpencode({ configPath: file, ...OPTIONS });
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
    await expect(readFile(`${file}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses JSONC input, merges it, and backs the original up to .bak", async () => {
    const root = await tempDir();
    const file = path.join(root, "jsonc", "opencode.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `{
  // user comment survives parsing
  "theme": "tokyonight",
  "model": "something-else",
  "providers": {
    /* block comment */
    "other": { "name": "Other" },
  },
}
`,
      "utf8",
    );

    const result = await installOpencode({ configPath: file, ...OPTIONS });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBe(`${file}.bak`);
    expect(result.modelCount).toBe(1);

    // Backup holds the original JSONC bytes.
    const backup = await readFile(`${file}.bak`, "utf8");
    expect(backup).toContain("// user comment survives parsing");
    expect(backup).toContain("\"model\": \"something-else\"");

    // The new file is clean JSON preserving user settings + other providers.
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(written["theme"]).toBe("tokyonight");
    expect(written["model"]).toBe("something-else");
    const providers = written["providers"] as Record<string, unknown>;
    expect(Object.keys(providers).sort()).toEqual(["airoute", "other"]);

    // A rerun on the now-clean JSON is a no-op.
    const rerun = await installOpencode({ configPath: file, ...OPTIONS });
    expect(rerun.changed).toBe(false);
  });

  it("honors dryRun: renders content, writes nothing", async () => {
    const root = await tempDir();
    const file = path.join(root, "dry", "opencode.json");

    const dry = await installOpencode({ configPath: file, ...OPTIONS, dryRun: true });
    expect(dry.created).toBe(true);
    expect(dry.changed).toBe(true);
    expect(dry.content).toContain("\"providers\"");
    const parsed = JSON.parse(dry.content) as unknown; // rendered content is valid JSON
    expect(parsed).toBeTruthy();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Dry run over an existing file also leaves it untouched.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{}\n", "utf8");
    const dry2 = await installOpencode({ configPath: file, ...OPTIONS, dryRun: true });
    expect(dry2.changed).toBe(true);
    expect(await readFile(file, "utf8")).toBe("{}\n");
  });

  it("throws when the existing file is not a JSON object", async () => {
    const root = await tempDir();
    const file = path.join(root, "array.json");
    await writeFile(file, "[1, 2]\n", "utf8");
    await expect(installOpencode({ configPath: file, ...OPTIONS })).rejects.toThrow(
      /must be a JSON object/,
    );
  });

  it("refuses to write when a non-free spec is passed", async () => {
    const root = await tempDir();
    const file = path.join(root, "paid.json");
    const paid = { ...spec("paid/gpt-x"), free: false as unknown as true };
    await expect(
      installOpencode({ configPath: file, ...OPTIONS, specs: [paid] }),
    ).rejects.toThrow(/non-free model "paid\/gpt-x"/);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("path resolution", () => {
  it("globalOpencodeConfigPath honors XDG_CONFIG_HOME", async () => {
    const { globalOpencodeConfigPath, projectOpencodeConfigPath } = await import(
      "@airoute/opencode"
    );
    expect(globalOpencodeConfigPath({}, "/home/u")).toBe(
      path.join("/home/u", ".config", "opencode", "opencode.json"),
    );
    expect(globalOpencodeConfigPath({ XDG_CONFIG_HOME: "/etc/x" }, "/home/u")).toBe(
      path.join("/etc/x", "opencode", "opencode.json"),
    );
    expect(projectOpencodeConfigPath("/repo")).toBe(path.join("/repo", "opencode.json"));
  });
});
