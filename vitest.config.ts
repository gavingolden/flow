import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["templates/scripts/**/*.test.ts", "src/**/*.test.ts"],
  },
});
