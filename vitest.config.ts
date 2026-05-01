import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bin/**/*.test.ts", "templates/scripts/**/*.test.ts", "src/**/*.test.ts"],
  },
});
