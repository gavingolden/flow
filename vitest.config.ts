import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bin/**/*.test.ts", "skills/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
