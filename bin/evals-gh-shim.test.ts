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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const here =
  import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const SHIM_PATH = path.resolve(here, "..", "evals", "_shims", "gh");

let fixtureDir!: string;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-gh-shim-"));
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(path.join(fixtureDir, name), JSON.stringify(value));
}

function runShim(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", [SHIM_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, FLOW_EVAL_FIXTURE: fixtureDir, ...env },
  });
}

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
});
