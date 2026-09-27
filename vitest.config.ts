import { defineConfig } from "vitest/config";

// Windows runners are slow enough to push tests that spawn processes or threads past 5 s.
export default defineConfig({
  test: { testTimeout: process.platform === "win32" ? 30_000 : 5_000 },
});
