/**
 * Spec for the hermetic `gh` shim at `evals/_shims/gh`, spawned as a real
 * subprocess (it is a `#!/usr/bin/env bun` script, not a bin/lib module —
 * there is nothing importable to unit-test in-process).
 *
 * Lives at `bin/evals-gh-shim.test.ts`, NOT `evals/_shims/gh.test.ts`:
 * `vitest.config.ts`'s `include` is `["bin/**\/*.test.ts",
 * "skills/**\/*.test.ts"]`, so a spec under `evals/` is never collected —
 * `npm run test -- evals/_shims/gh.test.ts` would exit 0 having run zero
 * tests, exactly the unfalsifiable green this PR exists to eliminate
 * (plan.md Contract adjustment #10).
 *
 * Issue #695's cross-check lives at the bottom of this file: every
 * committed scenario's declared `case.json` `ghCalls` argv is replayed
 * through the REAL shim subprocess (not re-implemented), so a scenario's
 * declaration and the shim's actual supported-argv surface can never
 * silently drift apart again the way the selector-less `pr view` gap did.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { loadSuite, type ResolvedScenario } from "./lib/eval-suite";

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const here =
  import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const SHIM_PATH = path.resolve(here, "..", "evals", "_shims", "gh");
const EVALS_ROOT = path.resolve(here, "..", "evals");

let fixtureDir!: string;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-gh-shim-"));
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// Shared, read-only across every consumer below: every scenario/test that
// needs a resolvable `currentBranch()` wants the byte-identical repo
// (branch `eval`, one empty commit) and never mutates it — the shim only
// ever `git rev-parse`s it. Building it once in a module-scope `beforeAll`
// instead of per-test/per-scenario cuts ~70 of this file's ~85 `git`
// subprocess spawns; nothing here weakens an assertion, since no consumer
// writes to `sharedGitRepoDir`.
let sharedGitRepoDir!: string;

beforeAll(() => {
  sharedGitRepoDir = makeGitRepo();
});

afterAll(() => {
  fs.rmSync(sharedGitRepoDir, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(path.join(fixtureDir, name), JSON.stringify(value));
}

function runShim(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
) {
  return spawnSync("bun", [SHIM_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, FLOW_EVAL_FIXTURE: fixtureDir, ...env },
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

/**
 * Builds a throwaway git repo checked out on branch `eval` with one commit
 * — mirrors `bin/lib/eval-fixture.ts`'s `materializeFixture` sequence
 * (`git init` -> commit -> `checkout -q -b eval`) closely enough for the
 * shim's `currentBranch()` to resolve "eval". An UNBORN branch (no commit
 * yet) makes `git rev-parse --abbrev-ref HEAD` fail with a non-zero exit,
 * which is why the commit comes before the checkout, not after.
 */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-gh-shim-repo-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `makeGitRepo: git ${args.join(" ")} exited ${r.status}: ${r.stderr}`,
      );
    }
    return r;
  };
  git(["init", "-q"]);
  git(["config", "user.email", "eval@flow.local"]);
  git(["config", "user.name", "flow-eval"]);
  git(["commit", "-q", "-m", "init", "--allow-empty"]);
  git(["checkout", "-q", "-b", "eval"]);
  return dir;
}

/** Mirrors `bin/evals-suites.test.ts`'s `discoverSuiteIds()` — walks every
 * committed suite under `evals/` via `loadSuite`, flattened to one entry
 * per scenario. Suites/scenarios that fail to load are skipped here
 * (`bin/evals-suites.test.ts`'s own `loadSuite` assertions are the
 * canonical failure signal for a malformed suite; this cross-check only
 * cares about scenarios that DID load). */
function discoverScenarios(): Array<{
  suiteId: string;
  scenario: ResolvedScenario;
}> {
  if (!fs.existsSync(EVALS_ROOT)) return [];
  const suiteIds = fs
    .readdirSync(EVALS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shims")
    .filter((d) => fs.existsSync(path.join(EVALS_ROOT, d.name, "suite.json")))
    .map((d) => d.name)
    .sort();
  const out: Array<{ suiteId: string; scenario: ResolvedScenario }> = [];
  for (const suiteId of suiteIds) {
    const loaded = loadSuite(path.join(EVALS_ROOT, suiteId));
    if (!loaded.ok) continue;
    for (const scenario of loaded.value.scenarios) {
      out.push({ suiteId, scenario });
    }
  }
  return out;
}

const discoveredScenarios = discoverScenarios();

// A guard against a silently-empty describe.each below: if evals/ ever
// loses every scenario, this assertion is the loud failure rather than a
// green run that cross-checked nothing. Mirrors bin/evals-suites.test.ts's
// "discovers at least one committed suite" guard.
it("discovers at least one committed scenario under evals/", () => {
  expect(discoveredScenarios.length).toBeGreaterThan(0);
});

// Un-gated, unlike the describe block below: if `bun` ever stops being
// installed, this assertion is the loud failure rather than the whole
// skipIf block silently reading green on zero executed assertions.
// Mirrors bin/evals-phase-write-shim.test.ts's identical guard.
it("bun is on PATH", () => {
  expect(bunOnPath).toBe(true);
});

describe.skipIf(!bunOnPath)("evals/_shims/gh", () => {
  describe("pr view", () => {
    it("answers requested fields from pr.json, keyed by number", () => {
      writeJson("pr.json", [{ number: 1, state: "OPEN", url: "https://x/1" }]);
      const r = runShim(["pr", "view", "1", "--json", "state,url"]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        state: "OPEN",
        url: "https://x/1",
      });
    });

    it("emits null for a requested field the PR record does not carry", () => {
      writeJson("pr.json", [{ number: 1, state: "OPEN" }]);
      const r = runShim(["pr", "view", "1", "--json", "state,mergeable"]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ state: "OPEN", mergeable: null });
    });

    it("exits 1 loudly when no PR matches the selector", () => {
      writeJson("pr.json", [{ number: 1, state: "OPEN" }]);
      const r = runShim(["pr", "view", "99", "--json", "state"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no PR matching");
    });

    describe("selector-less form (mirrors real gh's current-branch resolve)", () => {
      it("resolves a selector-less `pr view --json` call to the current branch", () => {
        writeJson("pr.json", [
          { number: 7, headRefName: "eval", url: "https://x/7" },
        ]);
        const r = runShim(
          ["pr", "view", "--json", "number,url"],
          {},
          sharedGitRepoDir,
        );
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({
          number: 7,
          url: "https://x/7",
        });
      });

      it("still exits 1 loudly when the current branch matches no PR", () => {
        writeJson("pr.json", []);
        const r = runShim(
          ["pr", "view", "--json", "number,url"],
          {},
          sharedGitRepoDir,
        );
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("no PR matching");
      });

      it("resolves an explicit selector and a selector-less call identically, regardless of flag order", () => {
        writeJson("pr.json", [
          { number: 7, headRefName: "eval", url: "https://x/7" },
        ]);
        const explicitFirst = runShim(
          ["pr", "view", "7", "--json", "number,url"],
          {},
          sharedGitRepoDir,
        );
        const jsonFirst = runShim(
          ["pr", "view", "--json", "number,url", "7"],
          {},
          sharedGitRepoDir,
        );
        const selectorLess = runShim(
          ["pr", "view", "--json", "number,url"],
          {},
          sharedGitRepoDir,
        );
        expect(explicitFirst.status).toBe(0);
        expect(jsonFirst.status).toBe(0);
        expect(selectorLess.status).toBe(0);
        const expected = { number: 7, url: "https://x/7" };
        expect(JSON.parse(explicitFirst.stdout)).toEqual(expected);
        expect(JSON.parse(jsonFirst.stdout)).toEqual(expected);
        expect(JSON.parse(selectorLess.stdout)).toEqual(expected);
      });

      it("still exits 1 loudly (never crashes) when cwd is not a git repo", () => {
        const nonRepoDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "evals-gh-shim-nonrepo-"),
        );
        try {
          writeJson("pr.json", [
            { number: 7, headRefName: "eval", url: "https://x/7" },
          ]);
          const r = runShim(
            ["pr", "view", "--json", "number,url"],
            {},
            nonRepoDir,
          );
          // currentBranch()'s non-repo guard makes resolveSelector fall all
          // the way through to `undefined`, which the shim treats as an
          // unsupported call (no selector at all) rather than "no PR
          // matching" (a resolved-but-unmatched selector).
          expect(r.status).toBe(1);
          expect(r.stderr).toContain("unsupported");
        } finally {
          fs.rmSync(nonRepoDir, { recursive: true, force: true });
        }
      });

      it("still exits 1 loudly (never crashes) on a detached HEAD", () => {
        const detachedRepoDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "evals-gh-shim-detached-"),
        );
        try {
          const git = (args: string[]) =>
            spawnSync("git", args, { cwd: detachedRepoDir, encoding: "utf8" });
          git(["init", "-q"]);
          git(["config", "user.email", "eval@flow.local"]);
          git(["config", "user.name", "flow-eval"]);
          git(["commit", "-q", "-m", "init", "--allow-empty"]);
          git(["checkout", "-q", "--detach", "HEAD"]);

          writeJson("pr.json", [
            { number: 7, headRefName: "eval", url: "https://x/7" },
          ]);
          const r = runShim(
            ["pr", "view", "--json", "number,url"],
            {},
            detachedRepoDir,
          );
          // Same reasoning as the non-repo case above: currentBranch()
          // treats the literal branch name "HEAD" as unresolved, so
          // resolveSelector falls through to `undefined` and the shim
          // reports "unsupported", not "no PR matching".
          expect(r.status).toBe(1);
          expect(r.stderr).toContain("unsupported");
        } finally {
          fs.rmSync(detachedRepoDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe("pr checks", () => {
    it("answers requested fields from checks.json when it exists", () => {
      writeJson("pr.json", [{ number: 1, state: "OPEN" }]);
      writeJson("checks.json", [
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "IN_PROGRESS" },
      ]);
      const r = runShim([
        "pr",
        "checks",
        "1",
        "--json",
        "name,state,startedAt,completedAt",
      ]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([
        { name: "build", state: "SUCCESS", startedAt: null, completedAt: null },
        {
          name: "test",
          state: "IN_PROGRESS",
          startedAt: null,
          completedAt: null,
        },
      ]);
    });

    it("exits 1 loudly (never a silent []) when checks.json is absent", () => {
      writeJson("pr.json", [{ number: 1, state: "OPEN" }]);
      const r = runShim(["pr", "checks", "1", "--json", "name,state"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("no checks reported");
    });

    it("still exits 1 loudly when checks.json is absent and --json is also omitted", () => {
      const r = runShim(["pr", "checks", "1"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
    });
  });

  describe("pr diff --name-only (bin/flow-fetch-pr-review.ts's fetchChangedFiles)", () => {
    it("prints one file per line from pr.json's files array", () => {
      writeJson("pr.json", [{ number: 1, files: ["a.ts", "b.ts"] }]);
      const r = runShim(["pr", "diff", "1", "--name-only"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("a.ts\nb.ts\n");
    });

    it("prints nothing (not a crash) when files is absent", () => {
      writeJson("pr.json", [{ number: 1 }]);
      const r = runShim(["pr", "diff", "1", "--name-only"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  describe("gh api pulls/<n>[/reviews|/comments] (bin/flow-fetch-pr-review.ts's other three fetches)", () => {
    const pr = {
      number: 1,
      title: "t",
      url: "https://x/1",
      state: "OPEN",
      body: "b",
      additions: 1,
      deletions: 2,
      changed_files: 1,
      headRefName: "feature",
      apiReviews: [
        {
          body: "lgtm",
          state: "APPROVED",
          user: { login: "r" },
          html_url: "https://x/r",
        },
      ],
      apiComments: [],
    };

    it("answers the bare pulls/<n> shape flow-fetch-pr-review.ts's fetchPr expects", () => {
      writeJson("pr.json", [pr]);
      const r = runShim(["api", "repos/{owner}/{repo}/pulls/1", "--jq", "."]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        title: "t",
        html_url: "https://x/1",
        number: 1,
        state: "OPEN",
        body: "b",
        additions: 1,
        deletions: 2,
        changed_files: 1,
        head: { ref: "feature" },
      });
    });

    it("answers the --paginate .../reviews shape as NDJSON from apiReviews", () => {
      writeJson("pr.json", [pr]);
      const r = runShim([
        "api",
        "--paginate",
        "repos/{owner}/{repo}/pulls/1/reviews",
        "--jq",
        ".",
      ]);
      expect(r.status).toBe(0);
      const lines = r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toEqual(pr.apiReviews);
    });

    it("answers the --paginate .../comments shape (empty) without crashing", () => {
      writeJson("pr.json", [pr]);
      const r = runShim([
        "api",
        "--paginate",
        "repos/{owner}/{repo}/pulls/1/comments",
        "--jq",
        ".",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  describe("unsupported subcommands", () => {
    it("exits 1 with a loud stderr for an unrecognized gh api resource", () => {
      writeJson("pr.json", [{ number: 1 }]);
      const r = runShim(["api", "repos/{owner}/{repo}/issues/1"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("unsupported");
    });

    it("exits 1 with a loud stderr for any other subcommand, never a silent success", () => {
      const r = runShim(["issue", "list"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("unsupported");
    });
  });

  describe.each(discoveredScenarios)(
    "scenario gh calls are answerable by the shim: $suiteId/$scenario.id",
    ({ suiteId, scenario }) => {
      it("every declared ghCalls argv resolves without an unsupported-subcommand or flag-read-as-selector error", () => {
        // `ghCalls` stays optional on ResolvedScenario by design (see
        // bin/lib/eval-suite.ts's resolveScenario) even though the
        // runtime default is always `[]` — normalize here rather than
        // widening the type.
        const ghCalls = scenario.ghCalls ?? [];
        // Nothing declared (scenario mounts no gh shim) — no argv to
        // replay. `bin/lib/eval-suite.ts`'s validator is what enforces
        // ghCalls is non-empty whenever fixture.shims DOES mount the gh
        // shim; this cross-check only replays what a scenario declared.
        if (ghCalls.length === 0) return;

        const scenarioFixtureDir = scenario.fixture?.repo
          ? path.join(scenario.dir, scenario.fixture.repo)
          : undefined;
        const seededFixtureDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "evals-gh-shim-scenario-fixture-"),
        );
        try {
          if (scenarioFixtureDir && fs.existsSync(scenarioFixtureDir)) {
            for (const name of fs.readdirSync(scenarioFixtureDir)) {
              if (!name.endsWith(".json")) continue;
              fs.copyFileSync(
                path.join(scenarioFixtureDir, name),
                path.join(seededFixtureDir, name),
              );
            }
          }
          for (const argv of ghCalls) {
            const r = runShim(
              argv,
              { FLOW_EVAL_FIXTURE: seededFixtureDir },
              sharedGitRepoDir,
            );
            // PLAN-DEVIATION correction, load-bearing: NOT
            // `not.toContain("unsupported")` and NOT `status === 0`. A
            // selector-less `pr view --json` (the exact defect this lint
            // exists to catch) exits 1 with `no PR matching '--json'` and
            // contains no "unsupported" substring, so a bare
            // unsupported-only check reads green on it — the second
            // alternative below catches a flag being misread as a
            // positional selector, the whole class of that bug. A blanket
            // `status === 0` check is also wrong: it would turn two
            // CORRECT scenarios red — checkpoint-pending-clear/s1 and /s3
            // both ship `pr.json: []` by design, so their declared
            // `pr view` argv legitimately gets a non-zero "no PR matching"
            // answer. The comma-bearing and pr.json-read alternatives
            // below additionally catch a regressed `--json`-value skip
            // (selector resolves to the field list, e.g. `number,url`)
            // and a scenario whose fixture ships no `pr.json` at all.
            expect(
              r.stderr,
              `${suiteId}/${scenario.id} argv ${JSON.stringify(argv)}: ${r.stderr}`,
            ).not.toMatch(
              /unsupported|no PR matching '(?:--|[^']*,)|could not read pr\.json|FLOW_EVAL_FIXTURE is not set/,
            );
          }
        } finally {
          fs.rmSync(seededFixtureDir, { recursive: true, force: true });
        }
      });
    },
  );
});
