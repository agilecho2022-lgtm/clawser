import os from "node:os";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const ciWorkers = process.platform === "win32" ? 2 : 3;

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: process.platform === "win32" ? 180_000 : 120_000,
    unstubEnvs: true,
    unstubGlobals: true,
    pool: "forks",
    maxWorkers: isCI ? ciWorkers : localWorkers,
    include: [
      "src/browser/**/*.test.ts",
      "src/cli/browser-cli*.test.ts",
      "src/cli/browser-cli-actions-input/**/*.test.ts",
      "src/cli/program/build-browser-only-program.test.ts",
      "src/gateway/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/vendor/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      all: false,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: [
        "./src/browser/**/*.ts",
        "./src/cli/browser-cli*.ts",
        "./src/cli/browser-cli-actions-input/**/*.ts",
        "./src/gateway/**/*.ts",
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/browser/**/*.live.test.ts",
        "src/browser/**/*.e2e.test.ts",
      ],
    },
  },
});
