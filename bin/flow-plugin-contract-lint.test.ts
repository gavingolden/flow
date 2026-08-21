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
import {
  checkPluginContract,
  dereferenceRoot,
  exitCodeFor,
  type ContractLintPhase,
} from "./flow-plugin-contract-lint";
import { moduleIds } from "./lib/modules";
import { pluginRootName } from "./lib/plugin-manifest";

const claudeMissing =
  spawnSync("sh", ["-c", "command -v claude"], { stdio: "pipe" }).status !== 0;

// checkPluginContract's own worst case is 4 x 20s DEFAULT_TIMEOUT_MS phases
// = 80s (validate-strict-deref, validate-shipped-root, list-skills-dir,
// plugin-dir-probe, each run sequentially) — PLUS 9 ensurePluginRoot
// materializations, two symlink passes, and the new 7-root `cp -RL` loop.
// This budget must stay comfortably above the 80s phase floor, or a slow
// claude cold start reads as a generic vitest timeout instead of the named
// "timed out after 20000ms" failure entry the lint itself is designed to
// produce.
const REAL_CLI_TIMEOUT_MS = 120_000;

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

  it("a Phase-1a strict-deref failure is isolated to its own phase and never leaks into Phase 2/3 (injected runClaude, no real claude needed)", async () => {
    const result = await checkPluginContract({
      tmpRoot,
      claudeOnPath: () => true,
      // Fail ONLY the strict-deref invocation (detected by the presence of
      // `--strict` in argv); every other invocation — the shipped-root
      // non-strict validate, `plugin list --json`, and the --plugin-dir
      // probe — reports success. This is the phase-isolation proof: it is
      // what makes "a Phase-1 regression can no longer make the Phase-2/3
      // specs lie" externally falsifiable.
      runClaude: async (args) => {
        if (args.includes("--strict")) {
          return { stdout: "", exitCode: 1, timedOut: false };
        }
        if (args.includes("--plugin-dir")) {
          const roots: string[] = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "--plugin-dir") roots.push(args[i + 1]);
          }
          const entries = roots.map((root) => ({
            id: `${path.basename(root)}@inline`,
            enabled: true,
            installPath: root,
          }));
          return {
            stdout: JSON.stringify(entries),
            exitCode: 0,
            timedOut: false,
          };
        }
        if (args[0] === "plugin" && args[1] === "list") {
          const entries = moduleIds().map((id) => ({
            id: `${pluginRootName(id)}@skills-dir`,
            enabled: true,
          }));
          return {
            stdout: JSON.stringify(entries),
            exitCode: 0,
            timedOut: false,
          };
        }
        // Phase 1b: shipped-root validate, no --strict.
        return { stdout: "", exitCode: 0, timedOut: false };
      },
    });
    expect(result.status).toBe("drifted");
    const phases = new Set<ContractLintPhase>(
      result.failures.map((f) => f.phase),
    );
    expect(phases).toEqual(
      new Set<ContractLintPhase>(["validate-strict-deref"]),
    );
    // Every strict-deref call failed, so nothing should have been pushed to
    // derefValidatedRoots — without this pin, deleting the `continue` after
    // the strict-fail push would make the vacuous-pass guard (see the
    // real-CLI spec below) permanently self-satisfying with nothing going
    // red.
    expect(result.derefValidatedRoots).toEqual([]);
    // Phase 3 still ran and reported both probe roots loaded — proving
    // Phase 1's failure did not short-circuit or poison Phase 3's own probe
    // accounting.
    expect(result.probedPluginDirRoots).toHaveLength(2);
  });

  it("a Phase-1b shipped-root validate failure is isolated to its own phase and never leaks into Phase 1a/2/3 (injected runClaude, no real claude needed)", async () => {
    const result = await checkPluginContract({
      tmpRoot,
      claudeOnPath: () => true,
      // Mirror image of the strict-deref isolation spec above: fail ONLY
      // the non-strict shipped-root validate; every other invocation — the
      // strict-deref validate, `plugin list --json`, and the --plugin-dir
      // probe — reports success.
      runClaude: async (args) => {
        if (args.includes("--strict")) {
          return { stdout: "", exitCode: 0, timedOut: false };
        }
        if (args.includes("--plugin-dir")) {
          const roots: string[] = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "--plugin-dir") roots.push(args[i + 1]);
          }
          const entries = roots.map((root) => ({
            id: `${path.basename(root)}@inline`,
            enabled: true,
            installPath: root,
          }));
          return {
            stdout: JSON.stringify(entries),
            exitCode: 0,
            timedOut: false,
          };
        }
        if (args[0] === "plugin" && args[1] === "list") {
          const entries = moduleIds().map((id) => ({
            id: `${pluginRootName(id)}@skills-dir`,
            enabled: true,
          }));
          return {
            stdout: JSON.stringify(entries),
            exitCode: 0,
            timedOut: false,
          };
        }
        // Phase 1b: shipped-root validate, no --strict.
        return { stdout: "", exitCode: 1, timedOut: false };
      },
    });
    expect(result.status).toBe("drifted");
    expect(
      result.failures.every((f) => f.phase === "validate-shipped-root"),
    ).toBe(true);
    expect(result.derefValidatedRoots).toHaveLength(moduleIds().length);
    expect(result.probedPluginDirRoots).toHaveLength(2);
  });

  it("a dereferenceRoot failure produces a materialize-phase entry and drops that root from the strict pass, without poisoning any other root (injected dereference)", async () => {
    const firstModuleRoot = { id: moduleIds()[0] };
    const result = await checkPluginContract({
      tmpRoot,
      claudeOnPath: () => true,
      // Fail dereferenceRoot for exactly one module (the first) so the spec
      // can assert both halves: the failing root drops out of the strict
      // pass, and every other root proceeds normally.
      dereference: (root, dest) =>
        root.includes(firstModuleRoot.id)
          ? { ok: false, detail: "injected materialize failure" }
          : dereferenceRoot(root, dest),
      runClaude: async (args) => {
        if (args.includes("--plugin-dir")) {
          const roots: string[] = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "--plugin-dir") roots.push(args[i + 1]);
          }
          const entries = roots.map((root) => ({
            id: `${path.basename(root)}@inline`,
            enabled: true,
            installPath: root,
          }));
          return {
            stdout: JSON.stringify(entries),
            exitCode: 0,
            timedOut: false,
          };
        }
        if (args[0] === "plugin" && args[1] === "list") {
          const entries = moduleIds().map((id) => ({
            id: `${pluginRootName(id)}@skills-dir`,
            enabled: true,
          }));
          return {
            stdout: JSON.stringify(entries),
            exitCode: 0,
            timedOut: false,
          };
        }
        return { stdout: "", exitCode: 0, timedOut: false };
      },
    });
    const materializeFailures = result.failures.filter(
      (f) => f.phase === "materialize",
    );
    expect(materializeFailures).toHaveLength(1);
    expect(materializeFailures[0].detail).toBe("injected materialize failure");
    expect(materializeFailures[0].root).toContain(firstModuleRoot.id);
    // The failing root never reached the strict pass, so it must be absent
    // from derefValidatedRoots — but every other module id's root still
    // passed.
    expect(result.derefValidatedRoots).toHaveLength(moduleIds().length - 1);
    expect(
      result.derefValidatedRoots.some((r) => r.includes(firstModuleRoot.id)),
    ).toBe(false);
  });

  describe(dereferenceRoot, () => {
    let unitTmpRoot!: string;

    beforeEach(() => {
      unitTmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-plugin-contract-lint-deref-unit-"),
      );
    });

    afterEach(() => {
      fs.rmSync(unitTmpRoot, { recursive: true, force: true });
    });

    it("reports a distinct actionable detail when the `cp` binary itself cannot be spawned (ENOENT)", () => {
      const src = path.join(unitTmpRoot, "src");
      fs.mkdirSync(src);
      const dest = path.join(unitTmpRoot, "dest");
      // A nonexistent PATH entry only, so `sh -c cp` cannot resolve `cp` —
      // spawnSync returns rather than throws, with status/stderr both null.
      const priorPath = process.env.PATH;
      process.env.PATH = "/nonexistent-flow-test-path";
      try {
        const result = dereferenceRoot(src, dest);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.detail).toContain("failed to spawn");
          expect(result.detail).not.toContain("exited null");
        }
      } finally {
        process.env.PATH = priorPath;
      }
    });

    it("reports a distinct actionable detail on a dangling component symlink (real `cp -RL` non-zero exit)", () => {
      const src = path.join(unitTmpRoot, "src");
      fs.mkdirSync(src);
      fs.symlinkSync(
        path.join(unitTmpRoot, "does-not-exist"),
        path.join(src, "dangling"),
      );
      const dest = path.join(unitTmpRoot, "dest");
      const result = dereferenceRoot(src, dest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toMatch(/^cp -RL exited \d+:/);
      }
    });
  });

  // The five real-CLI specs below share one checkPluginContract() run —
  // separately they'd each re-materialize 7 module roots + 2 probe roots
  // and fire 16 claude invocations (7 strict-deref + 7 shipped-root + 1
  // list + 1 plugin-dir-probe), quadrupling wall-clock cost for zero extra
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
      "every dereferenced root twin passes `claude plugin validate --strict` (real CLI)",
      () => {
        expect(
          result.failures.filter((f) => f.phase === "validate-strict-deref"),
        ).toEqual([]);
        // Vacuous-pass guard: a Phase-1a materialize failure would silently
        // drop every root from the strict pass, leaving `failures` clean for
        // the wrong reason (nothing was validated, not "validated clean").
        expect(result.derefValidatedRoots).toHaveLength(moduleIds().length);
      },
    );

    it.skipIf(claudeMissing)(
      "the shipped symlinked root still validates non-strict (real CLI)",
      () => {
        expect(
          result.failures.filter((f) => f.phase === "validate-shipped-root"),
        ).toEqual([]);
        // Positive observable, not just an absence-of-failure check — same
        // vacuous-pass guard rationale as derefValidatedRoots above.
        expect(result.shippedValidatedRoots).toHaveLength(moduleIds().length);
      },
    );

    it.skipIf(claudeMissing)(
      "a materialized root is reported by `claude plugin list --json` as <name>@skills-dir with enabled:true and no errors[] (real CLI)",
      () => {
        // Every module id's root landed cleanly — the absence of any
        // per-root failure entry IS the enabled:true/no-errors[] assertion,
        // since checkPluginContract records exactly that failure shape.
        for (const id of moduleIds()) {
          const name = pluginRootName(id);
          expect(
            result.failures.find(
              (f) => f.phase === "list-skills-dir" && f.root.includes(name),
            ),
          ).toBeUndefined();
        }
      },
    );

    it.skipIf(claudeMissing)(
      "repeated `--plugin-dir` roots are actually LOADED, not merely accepted (real CLI)",
      () => {
        expect(
          result.failures.filter((f) => f.phase === "plugin-dir-probe"),
        ).toEqual([]);
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
      failures: [
        {
          root: "/fake/root",
          phase: "validate-strict-deref",
          detail: "injected failure",
        },
      ],
      derefValidatedRoots: [],
      shippedValidatedRoots: [],
      probedPluginDirRoots: [],
    };
    expect(exitCodeFor(injectedResult)).toBe(1);
  });
});
