import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "fixtures/**/*.test.ts", "scripts/test/**/*.test.ts"],
    // Language fixtures are sources under analysis, and some of them are test files by their language's conventions.
    exclude: [...configDefaults.exclude, "fixtures/languages/**"],
    testTimeout: 30_000,
  },
});
