import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@replay/shared": path.join(root, "shared", "src", "index.ts"),
    },
  },
  test: {
    include: [
      "shared/test/**/*.test.ts",
      "server/test/**/*.test.ts",
      "sample/test/**/*.test.ts",
    ],
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
