import { defineConfig } from "vitest/config";
import { withNoProctitlePreload } from "./bin/lib/no-proctitle-env";

// Forked workers and nested Node children inherit this env, so none registers with LaunchServices on macOS.
Object.assign(process.env, withNoProctitlePreload(process.env));

export default defineConfig({
  test: {
    include: [
      "bin/**/*.test.ts",
      "skills/**/*.test.ts",
      "docs/eval/review-model-recall/**/*.test.ts",
      "docs/eval/argon-latency-probe/**/*.test.ts",
      "docs/eval/*.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
