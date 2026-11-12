import { defineConfig } from "vitest/config";

// Every test runs without network access and without Docker: the webhook tests talk to a server on a free
// localhost port that the test itself starts.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**"],
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded: the composition root and the interface-only file; main.ts is run for real by the local start of
      // the README.
      exclude: ["src/main.ts", "src/usecases/ports.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
