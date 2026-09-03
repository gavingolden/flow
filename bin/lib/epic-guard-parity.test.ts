/**
 * Behavioral parity regression: `flow-stop-guard.ts`'s route-naming
 * predicate (`installedGuardCapability` -> `statusRouteWorks`) and
 * `commitEpicStatus`'s actual outcome must never drift apart. Both read the
 * SAME producer (`installedGuardCapability` in `base-branch-guard.ts`), so
 * this asserts that fact holds behaviorally, not just structurally — a real
 * temp git repo, a real installed hook, and a real `commitEpicStatus` call
 * per fixture, not two independent string assertions that happen to agree
 * today.
 *
 * ENV: the guard only engages when BOTH `CLAUDE_CODE_SESSION_ID` and a flow
 * slug are set (the INVERSE of `base-branch-guard.test.ts`'s `baseEnv()`,
 * which strips them because that suite runs inside a real flow session) —
 * set-and-restore around every fixture so a leak can't affect a sibling
 * file (an already-observed cross-file flake source in this repo).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  BASE_BRANCH_GUARD_HOOK,
  BASE_BRANCH_GUARD_MARKER,
  BASE_BRANCH_GUARD_VERSION,
  LEGACY_HOOK_BODIES,
  installedGuardCapability,
} from "./base-branch-guard";
import { commitEpicStatus, epicStatusRelPath } from "./epic-metadata-commit";
import { buildEpicMetadataReminder, run, type Deps } from "../flow-stop-guard";
import type { PipelineState } from "./state";

type Fixture = {
  name: string;
  hook: string | null; // null = no hook file at all (the "absent" fixture)
};

const FIXTURES: Fixture[] = [
  { name: "absent", hook: null },
  {
    name: `v${BASE_BRANCH_GUARD_VERSION} (current)`,
    hook: BASE_BRANCH_GUARD_HOOK,
  },
  { name: "v4", hook: LEGACY_HOOK_BODIES["base-branch"][3] },
  { name: "v3", hook: LEGACY_HOOK_BODIES["base-branch"][2] },
  { name: "legacy", hook: LEGACY_HOOK_BODIES["base-branch"][0] },
  { name: "foreign", hook: "#!/bin/sh\nexit 1\n" },
  {
    name: "hand-edited-marker-removed",
    hook: BASE_BRANCH_GUARD_HOOK.split("\n")
      .filter((line) => !line.startsWith(BASE_BRANCH_GUARD_MARKER))
      .join("\n"),
  },
  {
    name: "hand-edited-marker-intact",
    hook: `${LEGACY_HOOK_BODIES["base-branch"][2]}# custom line 1\n# custom line 2\n`,
  },
];

function withSessionMarkers<T>(fn: () => T): T {
  const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
  const prevSlug = process.env.FLOW_SLUG;
  process.env.CLAUDE_CODE_SESSION_ID = "sess-parity-test";
  process.env.FLOW_SLUG = "parity-test";
  try {
    return fn();
  } finally {
    if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
    if (prevSlug === undefined) delete process.env.FLOW_SLUG;
    else process.env.FLOW_SLUG = prevSlug;
  }
}

// ASYNC-SAFE BY CONSTRUCTION: every call site is `await`ed and this always
// returns a Promise (even for a synchronous `run`) so `fs.rmSync` in
// `finally` can never fire before an async `run` actually settles. An
// un-awaited `return run(repoRoot)` would let `finally` delete `repoRoot`
// out from under an in-flight async callback — observed directly while
// writing this test: the deleted dir made `resolveHooksTarget` fail-open to
// "absent" (fs.existsSync false), turning a "foreign" fixture into a false
// "satisfiable" route mid-flight.
async function withFixtureRepo<T>(
  fixture: Fixture,
  run: (repoRoot: string) => T | Promise<T>,
): Promise<T> {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `flow-guard-parity-${fixture.name}-`),
  );
  try {
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repoRoot,
    });
    execFileSync("git", ["config", "user.name", "Flow Test"], {
      cwd: repoRoot,
    });
    fs.mkdirSync(path.join(repoRoot, ".flow", "epics", "e1"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, epicStatusRelPath("e1")),
      "{}\n",
      "utf8",
    );
    // One initial commit so `HEAD` is a real ref before the board commit —
    // mirrors a real epic repo, which is never a zero-commit checkout.
    fs.writeFileSync(path.join(repoRoot, "README.md"), "seed\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoRoot });

    if (fixture.hook !== null) {
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.writeFileSync(hookPath, fixture.hook, "utf8");
      fs.chmodSync(hookPath, 0o755);
    }
    return await run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function namesSyncRouteFor(repoRoot: string): boolean {
  const rel = epicStatusRelPath("e1");
  const statusRouteWorks = (root: string): boolean => {
    const cap = installedGuardCapability(root);
    return cap.allowsStatusBoard || cap.selfHealable;
  };
  const lines = buildEpicMetadataReminder([{ root: repoRoot, path: rel }], {
    onBaseBranch: true,
    statusRouteWorks,
  });
  return lines
    .join("\n")
    .includes("flow-epic-sync --epic-slug e1 --commit --push");
}

function boardReachedHeadFor(repoRoot: string): boolean {
  const writtenPath = path.join(repoRoot, epicStatusRelPath("e1"));
  const result = withSessionMarkers(() =>
    commitEpicStatus({ writtenPath, epicSlug: "e1", cwd: repoRoot }),
  );
  return result.committed;
}

async function driveRun(repoRoot: string, rel: string): Promise<number> {
  const deps: Deps = {
    readStdin: async () => JSON.stringify({ stop_hook_active: true }),
    flowSlugEnv: "parity-test",
    loadState: (): PipelineState => ({
      slug: "parity-test",
      phase: "verifying",
      repo: repoRoot,
      updatedAt: new Date().toISOString(),
    }),
    writeErr: () => {},
    readTurn: () => null,
    writeTurn: () => {},
    nowIso: () => new Date().toISOString(),
    dirtyEpicPaths: () => [rel],
    repoCommitState: () => "clean",
    guardCapability: (root) => installedGuardCapability(root),
  };
  return run(deps);
}

describe("epic-guard-parity: installedGuardCapability drives both consumers identically", () => {
  // Fixtures where the guard's PROMISE (namesSyncRoute) and the helper's
  // OUTCOME (boardReachedHead) must be byte-for-byte equal. Excludes
  // "hand-edited-marker-removed" — see the dedicated test below for why
  // that one fixture is a documented, SAFE asymmetry rather than a bug.
  const STRICT_PARITY_FIXTURES = FIXTURES.filter(
    (f) => f.name !== "hand-edited-marker-removed",
  );

  for (const fixture of STRICT_PARITY_FIXTURES) {
    it(`${fixture.name}: namesSyncRoute === boardReachedHead`, async () => {
      await withFixtureRepo(fixture, (repoRoot) => {
        const rel = epicStatusRelPath("e1");
        const namesSyncRoute = namesSyncRouteFor(repoRoot);
        const boardReachedHead = boardReachedHeadFor(repoRoot);
        expect(
          namesSyncRoute,
          `fixture "${fixture.name}": guard named the sync route = ${namesSyncRoute}, but commitEpicStatus actually committed = ${boardReachedHead}`,
        ).toBe(boardReachedHead);
        void rel;
      });
    });
  }

  // Documented exception: a hand-edited hook that DROPS just the version
  // marker comment is byte-identical to v4 in every LINE THAT MATTERS to
  // the shell logic, so the real hook still allows the commit even though
  // flow's classifier — correctly and conservatively — can no longer prove
  // ownership and calls it "foreign". This is the SAFE direction of
  // asymmetry (the guard under-promises, never over-promises): it never
  // names a route that then fails, which is the exact bug class this PR
  // closes. A `namesSyncRoute === boardReachedHead` assertion would fail
  // here for a reason that has nothing to do with route safety, so it is
  // asserted directly instead.
  it("hand-edited-marker-removed: classifies foreign (conservative under-promise), even though the underlying hook still happens to work", async () => {
    const fixture = FIXTURES.find(
      (f) => f.name === "hand-edited-marker-removed",
    )!;
    await withFixtureRepo(fixture, (repoRoot) => {
      const cap = installedGuardCapability(repoRoot);
      expect(cap.classification).toBe("foreign");
      expect(namesSyncRouteFor(repoRoot)).toBe(false);
      // The underlying hook logic is unaffected by dropping one comment
      // line, so the real commit still succeeds — proving the mismatch is
      // a safe under-promise, not a data-loss risk.
      expect(boardReachedHeadFor(repoRoot)).toBe(true);
    });
  });

  it("v3 (self-heal enabled) leaves v4 on disk after commitEpicStatus runs", async () => {
    const fixture = FIXTURES.find((f) => f.name === "v3")!;
    await withFixtureRepo(fixture, (repoRoot) => {
      boardReachedHeadFor(repoRoot);
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      expect(fs.readFileSync(hookPath, "utf8")).toBe(BASE_BRANCH_GUARD_HOOK);
    });
  });

  it("hand-edited-marker-intact leaves its hook byte-for-byte unchanged", async () => {
    const fixture = FIXTURES.find(
      (f) => f.name === "hand-edited-marker-intact",
    )!;
    await withFixtureRepo(fixture, (repoRoot) => {
      boardReachedHeadFor(repoRoot);
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      expect(fs.readFileSync(hookPath, "utf8")).toBe(fixture.hook);
    });
  });

  it("foreign drives flow-stop-guard's run() to exit 0 with a diagnostic, never exit 2", async () => {
    const fixture = FIXTURES.find((f) => f.name === "foreign")!;
    await withFixtureRepo(fixture, async (repoRoot) => {
      const rel = epicStatusRelPath("e1");
      const exit = await driveRun(repoRoot, rel);
      expect(exit).toBe(0);
      expect(exit).not.toBe(2);
    });
  });

  it("flow-stop-guard.ts derives its route from installedGuardCapability, not a re-encoded version literal", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "flow-stop-guard.ts"),
      "utf8",
    );
    expect(source).toContain("installedGuardCapability");
    // Isolate the routing predicate itself (statusRouteWorks's definition,
    // the one place a re-encoded version literal could sneak back in) and
    // assert it contains no bare `v4` / `=== 4` literal — the route
    // decision must come from `capability.allowsStatusBoard` /
    // `capability.selfHealable`, never a re-derived version check.
    const match = source.match(
      /const statusRouteWorks = \(root: string\): boolean => \{[\s\S]*?\n {4}\};/,
    );
    expect(
      match,
      "statusRouteWorks definition not found in flow-stop-guard.ts",
    ).not.toBeNull();
    const body = match![0];
    expect(body).toContain("deps.guardCapability(root)");
    expect(body).not.toMatch(/v4\b/);
    expect(body).not.toMatch(/===\s*4\b/);
  });
});
