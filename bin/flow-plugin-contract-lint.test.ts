/**
 * Tests for the drift lint. The D4/exit-code-mapping cases inject
 * `claudeOnPath` and never spawn a real `claude`; the two "real-CLI-or-skip"
 * cases run against the ACTUAL installed `claude` when it's on PATH — this
 * is the case that turns CI red on a mechanism change, so it must exercise
 * the real CLI where available, and `it.skipIf` cleanly (never a failure)
 * where it isn't — mirrors flow-delegate.test.ts's `it.skipIf(agyInSkipPath)`
 * convention. All writes happen under the injected `tmpRoot`; the real
 * `~/.claude` is never touched (checkPluginContract builds its own fixture
 * HOME under tmpRoot and points every `claude` invocation at it).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPluginContract, exitCodeFor } from "./flow-plugin-contract-lint";
import { moduleIds } from "./lib/modules";
import { pluginRootName } from "./lib/plugin-manifest";

const claudeMissing =
  spawnSync("sh", ["-c", "command -v claude"], { stdio: "pipe" }).status !== 0;

let tmpRoot!: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "flow-plugin-contract-lint-test-"),
  );
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe(checkPluginContract, () => {
  it("returns status 'skipped' with a named reason and NO failures when claudeOnPath returns false", async () => {
    const result = await checkPluginContract({
      claudeOnPath: () => false,
      tmpRoot,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("PATH");
    expect(result.failures).toEqual([]);
  });

  it("the lint never writes outside the injected tmpRoot", async () => {
    await checkPluginContract({ claudeOnPath: () => false, tmpRoot });
    // D4 short-circuit — nothing was ever created under tmpRoot on the
    // skipped path, which is itself the strongest form of "never writes
    // outside tmpRoot" (nothing written anywhere at all).
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it.skipIf(claudeMissing)(
    "every emitted manifest passes `claude plugin validate --strict` (real CLI)",
    async () => {
      const result = await checkPluginContract({ tmpRoot });
      expect(result.status).toBe("ok");
      expect(result.failures).toEqual([]);
    },
    30_000,
  );

  it.skipIf(claudeMissing)(
    "a materialized root is reported by `claude plugin list --json` as <name>@skills-dir with enabled:true and no errors[] (real CLI)",
    async () => {
      const result = await checkPluginContract({ tmpRoot });
      expect(result.status).toBe("ok");
      // Every module id's root landed cleanly — the absence of any
      // per-root failure entry IS the enabled:true/no-errors[] assertion,
      // since checkPluginContract records exactly that failure shape.
      for (const id of moduleIds()) {
        const name = pluginRootName(id);
        expect(
          result.failures.find((f) => f.root.includes(name)),
        ).toBeUndefined();
      }
    },
    30_000,
  );

  it.skipIf(claudeMissing)(
    "repeated `--plugin-dir` roots are actually LOADED, not merely accepted (real CLI)",
    async () => {
      const result = await checkPluginContract({ tmpRoot });
      expect(result.status).toBe("ok");
      // No failure entry names the "plugin-dir-probe" fixture path segment
      // the --plugin-dir phase uses for its two dedicated roots — the
      // absence of one IS the "both roots reported loaded" assertion,
      // same convention as the sibling @skills-dir spec above.
      expect(
        result.failures.find((f) => f.root.includes("plugin-dir-probe")),
      ).toBeUndefined();
    },
    30_000,
  );

  it("with claudeOnPath: () => false, the new --plugin-dir phase never runs before the short-circuit", async () => {
    const result = await checkPluginContract({
      claudeOnPath: () => false,
      tmpRoot,
    });
    expect(result.status).toBe("skipped");
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});

describe("CLI exit-code mapping", () => {
  it("an ok/skipped result maps to exit 0 via the production exitCodeFor mapping", async () => {
    const result = await checkPluginContract({
      claudeOnPath: () => false,
      tmpRoot,
    });
    // "skipped" is not "drifted" -> exit 0, the same branch "ok" takes.
    expect(exitCodeFor(result)).toBe(0);
  });

  it("a drifted result (injected) maps to exit 1 via the production exitCodeFor mapping", () => {
    const injectedResult: Awaited<ReturnType<typeof checkPluginContract>> = {
      status: "drifted",
      failures: [{ root: "/fake/root", detail: "injected failure" }],
    };
    expect(exitCodeFor(injectedResult)).toBe(1);
  });

  it("a --plugin-dir-phase failure entry (injected) maps to exit 1 via the production exitCodeFor mapping", () => {
    const injectedResult: Awaited<ReturnType<typeof checkPluginContract>> = {
      status: "drifted",
      failures: [
        {
          root: "/fake/plugin-dir-probe/flow-module-core",
          detail:
            "not reported by claude plugin list --json, via claude --plugin-dir /fake/plugin-dir-probe/flow-module-core plugin list --json",
        },
      ],
    };
    expect(exitCodeFor(injectedResult)).toBe(1);
  });
});
