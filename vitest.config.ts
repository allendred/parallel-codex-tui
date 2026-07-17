import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      PARALLEL_CODEX_INHERIT_SYSTEM_PROXY: "0"
    },
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 10000
  }
});
