import { defineConfig } from "vitest/config";
import { withNoProctitlePreload } from "./bin/lib/no-proctitle-env";

// vitest >= 4 workers no longer set a process title; the preload now covers nested Node children (npm/npx) the suite spawns.
Object.assign(process.env, withNoProctitlePreload(process.env));

export default defineConfig({
  test: {
    // Pins the vitest 5 default: bin/lib/feature.test.ts's module-scope vi.fn mocks rely on per-test call-history clearing.
    clearMocks: true,
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
