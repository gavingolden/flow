import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "bin/**/*.test.ts",
      "skills/**/*.test.ts",
      "docs/eval/review-model-recall/**/*.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
