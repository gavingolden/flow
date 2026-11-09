import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("vitest.setup.ts under a shared-worker (--no-isolate) run", () => {
  it("applies mocks, leaks nothing forward, and gives stdin end-of-input", () => {
    const result = spawnSync(
      path.join(repoRoot, "node_modules/.bin/vitest"),
      ["run", "--config", "bin/fixtures/no-isolate/vitest.fixture.config.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const tail = output.split("\n").slice(-40).join("\n");

    expect(
      result.status,
      `nested run failed (status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"}):\n${tail}`,
    ).toBe(0);
    expect(output, tail).toContain("4 passed");
  }, 90_000);
});
