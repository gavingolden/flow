/**
 * Tests for the drift lint. The D4/exit-code-mapping cases inject
 * `claudeOnPath` and never spawn a real `claude`; the "real CLI" describe
 * block runs against the ACTUAL installed `claude` when it's on PATH — this
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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { checkPluginContract, exitCodeFor } from "./flow-plugin-contract-lint";
import { moduleIds } from "./lib/modules";
import { pluginRootName } from "./lib/plugin-manifest";

const claudeMissing =
  spawnSync("sh", ["-c", "command -v claude"], { stdio: "pipe" }).status !== 0;

// checkPluginContract's own worst case rose to 60s with the --plugin-dir
// probe phase (3 sequential 20s DEFAULT_TIMEOUT_MS phases) — this budget
// must stay above that, or a slow claude cold start reads as a generic
// vitest timeout instead of the named "timed out after 20000ms" failure
// entry the lint itself is designed to produce.
const REAL_CLI_TIMEOUT_MS = 90_000;

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

  it("the lint never writes outside the injected tmpRoot, including the --plugin-dir probe fixture roots phase 3 would otherwise materialize", async () => {
    await checkPluginContract({ claudeOnPath: () => false, tmpRoot });
    // D4 short-circuit — nothing was ever created under tmpRoot on the
    // skipped path (including phase 3's own plugin-dir-probe fixtures),
    // which is itself the strongest form of "never writes outside tmpRoot"
    // (nothing written anywhere at all).
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("Phase 3 goes 'drifted' with a --plugin-dir-named failure when claude reports the probe roots un-loaded (injected runClaude, no real claude needed)", async () => {
    const result = await checkPluginContract({
      tmpRoot,
      claudeOnPath: () => true,
      // Every runClaude call — Phase 1's validate, Phase 2's list, and
      // Phase 3's --plugin-dir probe — is stubbed to report nothing
      // loaded, so Phase 3's own entry-matching predicate is what's
      // pinned here: an empty listing must surface a
      // "not reported ... plugin-dir-probe" failure, not a false green.
      runClaude: async () => ({ stdout: "[]", exitCode: 0, timedOut: false }),
    });
    expect(result.status).toBe("drifted");
    expect(
      result.failures.some((f) => f.root.includes("plugin-dir-probe")),
    ).toBe(true);
    expect(result.probedPluginDirRoots).toEqual([]);
  });

  // The three real-CLI specs below share one checkPluginContract() run —
  // separately they'd each re-materialize 7 module roots + 2 probe roots
  // and fire 9 claude invocations, tripling wall-clock cost for zero extra
  // coverage since they assert on disjoint slices of the same result.
  describe("real CLI", () => {
    let result: Awaited<ReturnType<typeof checkPluginContract>>;
    let sharedTmpRoot!: string;

    beforeAll(async () => {
      sharedTmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-plugin-contract-lint-test-shared-"),
      );
      result = await checkPluginContract({ tmpRoot: sharedTmpRoot });
    }, REAL_CLI_TIMEOUT_MS);

    afterAll(() => {
      fs.rmSync(sharedTmpRoot, { recursive: true, force: true });
    });

    it.skipIf(claudeMissing)(
      "every emitted manifest passes `claude plugin validate --strict` (real CLI)",
      () => {
        expect(result.status).toBe("ok");
        expect(result.failures).toEqual([]);
      },
    );

    it.skipIf(claudeMissing)(
      "a materialized root is reported by `claude plugin list --json` as <name>@skills-dir with enabled:true and no errors[] (real CLI)",
      () => {
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
    );

    it.skipIf(claudeMissing)(
      "repeated `--plugin-dir` roots are actually LOADED, not merely accepted (real CLI)",
      () => {
        expect(result.status).toBe("ok");
        // Positive observable, not just an absence-of-failure check: a
        // deleted/no-op Phase 3 would leave probedPluginDirRoots empty
        // even though `failures` staying [] wouldn't otherwise notice.
        expect(result.probedPluginDirRoots).toHaveLength(2);
        for (const root of result.probedPluginDirRoots) {
          expect(root).toContain("plugin-dir-probe");
        }
      },
    );
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
      probedPluginDirRoots: [],
    };
    expect(exitCodeFor(injectedResult)).toBe(1);
  });
});
