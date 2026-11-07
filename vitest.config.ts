import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run against package sources (no prebuilt dist needed): workspace
 * packages are aliased to their entry `src` files.
 */
const toPath = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@airoute/core": toPath("./packages/core/src/index.ts"),
      "@airoute/gateway": toPath("./packages/gateway/src/index.ts"),
      "@airoute/mock-provider": toPath("./e2e/mock-provider/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    environment: "node",
  },
});
