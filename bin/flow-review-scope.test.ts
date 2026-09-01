import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DELTA_RATIO_THRESHOLD,
  parseArgs,
  renderNotices,
  resolveScope,
  run,
  syntheticGatedArtifact,
  type ReviewScope,
} from "./flow-review-scope";

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;
const gitOnPath = spawnSync("git", ["--version"]).status === 0;
const here =
  import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = path.join(here, "flow-review-scope.ts");

const BASE_INPUT = {
  headSha: "head1234",
  markerSha: null as string | null,
  isAncestor: false,
  priorStatus: null as string | null,
  prFiles: ["a.ts"],
  changedSinceMarker: [] as string[],
  fullDiffLines: 100,
  deltaDiffLines: 0,
  deltaEnabled: true,
  forceFull: false,
};

describe("resolveScope", () => {
  it("returns full 'no prior marker' when markerSha is null", () => {
    const r = resolveScope({ ...BASE_INPUT, markerSha: null });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe("no prior marker");
  });

  it("returns full 'marker equals HEAD (Gatekeeper owns the no-new-commits skip)' when marker === head", () => {
    const r = resolveScope({ ...BASE_INPUT, markerSha: "head1234" });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe(
      "marker equals HEAD (Gatekeeper owns the no-new-commits skip)",
    );
  });

  it("returns full 'marker not an ancestor of HEAD' when isAncestor is false", () => {
    const r = resolveScope({
      ...BASE_INPUT,
      markerSha: "abc1234",
      isAncestor: false,
    });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe("marker not an ancestor of HEAD");
  });

  it("returns full 'prior review not clean (escalated)' when priorStatus !== 'clean'", () => {
    const r = resolveScope({
      ...BASE_INPUT,
      markerSha: "abc1234",
      isAncestor: true,
      priorStatus: "escalated",
    });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe("prior review not clean (escalated)");
  });

  it("returns full 'delta scope disabled' when deltaEnabled false", () => {
    const r = resolveScope({
      ...BASE_INPUT,
      markerSha: "abc1234",
      isAncestor: true,
      priorStatus: "clean",
      deltaEnabled: false,
    });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe("delta scope disabled");
  });

  it("returns full 'forced full (widen)' when forceFull", () => {
    const r = resolveScope({
      ...BASE_INPUT,
      markerSha: "abc1234",
      isAncestor: true,
      priorStatus: "clean",
      forceFull: true,
    });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe("forced full (widen)");
  });

  it("returns full 'delta ≥ 75% of PR diff' when the ratio meets DELTA_RATIO_THRESHOLD", () => {
    const r = resolveScope({
      ...BASE_INPUT,
      markerSha: "abc1234",
      isAncestor: true,
      priorStatus: "clean",
      fullDiffLines: 100,
      deltaDiffLines: 80,
    });
    expect(r.scope).toBe("full");
    expect(r.reason).toBe("delta ≥ 75% of PR diff");
    expect(80 / 100).toBeGreaterThanOrEqual(DELTA_RATIO_THRESHOLD);
  });

  it("returns delta with delta_files = intersection and delta_ratio otherwise", () => {
    const r = resolveScope({
      ...BASE_INPUT,
      markerSha: "abc1234",
      isAncestor: true,
      priorStatus: "clean",
      prFiles: ["a.ts", "b.ts"],
      changedSinceMarker: ["a.ts", "c.ts"],
      fullDiffLines: 100,
      deltaDiffLines: 10,
    });
    expect(r.scope).toBe("delta");
    expect(r.delta_files).toEqual(["a.ts"]);
    expect(r.delta_ratio).toBeCloseTo(0.1);
  });
});

function scopeFixture(overrides: Partial<ReviewScope> = {}): ReviewScope {
  return {
    version: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    scope: "delta",
    reason: "delta re-entry",
    base_sha: "abcdefg1234",
    head_sha: "1234567abcd",
    pr_files: ["a.ts"],
    delta_files: ["a.ts"],
    delta_ratio: 0.1,
    gates: {
      "bug-detection": { run: true, reason: "always-on lens" },
      security: { run: true, reason: "not docs-only" },
      "pattern-consistency": { run: true, reason: "always-on lens" },
      performance: { run: false, reason: "docs-only diff (1 files)" },
      "supply-chain": {
        run: false,
        reason: "no manifest/lockfile among 1 changed files",
      },
      "test-coverage": { run: false, reason: "docs-only diff (1 files)" },
    },
    gates_enabled: true,
    delta_enabled: true,
    forced_full: false,
    ...overrides,
  };
}

describe("renderNotices", () => {
  it("emits the review-scope line first then one lens-gated line per gated lens", () => {
    const notices = renderNotices(scopeFixture());
    expect(notices[0]).toMatch(
      /^NOTICE — review-scope: delta abcdefg\.\.1234567 /,
    );
    const gated = notices.slice(1);
    expect(gated).toEqual([
      "NOTICE — lens-gated: performance skipped (docs-only diff (1 files))",
      "NOTICE — lens-gated: supply-chain skipped (no manifest/lockfile among 1 changed files)",
      "NOTICE — lens-gated: test-coverage skipped (docs-only diff (1 files))",
    ]);
  });
});

describe("syntheticGatedArtifact", () => {
  it("carries the three required negative-findings keys as empty arrays plus gated.reason", () => {
    const artifact = syntheticGatedArtifact("docs-only diff (1 files)");
    expect(artifact).toEqual({
      findings: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      gated: { reason: "docs-only diff (1 files)" },
    });
  });
});

describe("parseArgs", () => {
  it("returns error on missing --pr", () => {
    const r = parseArgs(["--worktree", "/tmp/x"]);
    expect("error" in r).toBe(true);
  });
});

function gitc(cwd: string, args: string[]) {
  return spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!bunOnPath || !gitOnPath)("run() end-to-end", () => {
  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-scope-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    fs.mkdirSync(path.join(dir, ".flow-tmp"), { recursive: true });
    gitc(dir, ["add", "-A"]);
    gitc(dir, ["commit", "-q", "-m", "commit A"]);
    const shaA = gitc(dir, ["rev-parse", "HEAD"]).stdout.trim();
    fs.writeFileSync(path.join(dir, ".flow-tmp", "pr-review-last-sha"), shaA);
    fs.writeFileSync(
      path.join(dir, ".flow-tmp", "pr-review-result.json"),
      JSON.stringify({ status: "clean" }),
    );
    fs.appendFileSync(path.join(dir, "a.ts"), "export const b = 2;\n");
    gitc(dir, ["add", "-A"]);
    gitc(dir, ["commit", "-q", "-m", "commit B touching a.ts"]);
    scratchDirs.push(dir);
    return dir;
  }

  it("writes review-scope.json with scope delta, diff.txt containing only the B hunk, and synthetic artifacts for gated lenses", async () => {
    const dir = makeRepo();
    const filler = Array.from({ length: 40 }, (_, i) => ` filler line ${i}`);
    const fakeDiff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      " export const a = 1;",
      "+export const b = 2;",
      "diff --git a/other.ts b/other.ts",
      "index 333..444 100644",
      "--- a/other.ts",
      "+++ b/other.ts",
      "@@ -1,40 +1,40 @@",
      ...filler,
      "",
    ].join("\n");
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: "a.ts\n", exitCode: 0 };
      }
      if (args[0] === "pr" && args[1] === "diff") {
        return { stdout: fakeDiff, exitCode: 0 };
      }
      return { stdout: "", exitCode: 1 };
    };
    const git = (args: string[], cwd: string) => {
      const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      return { stdout: r.stdout ?? "", exitCode: r.status ?? 1 };
    };
    const code = await run(["--pr", "5", "--worktree", dir], {
      gh,
      git,
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      homeDir: dir,
    });
    expect(code).toBe(0);
    const scope = JSON.parse(
      fs.readFileSync(path.join(dir, ".flow-tmp", "review-scope.json"), "utf8"),
    );
    expect(scope.scope).toBe("delta");
    const diffText = fs.readFileSync(
      path.join(dir, ".flow-tmp", "diff.txt"),
      "utf8",
    );
    expect(diffText).toContain("export const b = 2;");
    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".flow-tmp", "agent-output-supply-chain.json"),
        "utf8",
      ),
    );
    expect(artifact.gated).toBeDefined();
  });

  it("exits 2 on missing --pr", async () => {
    const dir = makeRepo();
    const code = await run(["--worktree", dir], {
      gh: () => ({ stdout: "", exitCode: 0 }),
      git: () => ({ stdout: "", exitCode: 0 }),
      readFile: () => null,
      writeFile: () => {},
      now: () => new Date(),
      homeDir: dir,
    });
    expect(code).toBe(2);
  });

  it("with --no-gates marks every lens run:true", async () => {
    const dir = makeRepo();
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view")
        return { stdout: "a.ts\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };
    const git = (args: string[], cwd: string) => {
      const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      return { stdout: r.stdout ?? "", exitCode: r.status ?? 1 };
    };
    const code = await run(["--pr", "5", "--worktree", dir, "--no-gates"], {
      gh,
      git,
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      },
      now: () => new Date(),
      homeDir: dir,
    });
    expect(code).toBe(0);
    const scope = JSON.parse(
      fs.readFileSync(path.join(dir, ".flow-tmp", "review-scope.json"), "utf8"),
    );
    for (const verdict of Object.values(scope.gates) as { run: boolean }[]) {
      expect(verdict.run).toBe(true);
    }
  });
});

describe.skipIf(!bunOnPath)("bare CLI invocation", () => {
  it("is executable", () => {
    expect(fs.statSync(SCRIPT_PATH).mode & 0o111).not.toBe(0);
  });
});
