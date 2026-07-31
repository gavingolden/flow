/**
 * Tests for `bin/flow-conflict-marker-check.ts` against real git semantics in
 * scratch repos — mirroring `bin/flow-pre-commit.test.ts:2496`'s integration
 * fixture shape and its `spawnSync("bun", ["--version"]).status === 0` skip
 * idiom for the bun-dependent end-to-end cases.
 *
 * FIXTURE HAZARD: every marker fixture is built via `.join("\n")` /
 * `\n`-escaped single-line strings, never a column-0 multi-line template
 * literal — a literal `<<<<<<< HEAD` at the start of a line in this TRACKED
 * .test.ts file would make flow's own `checkConflictMarkers` gate fail on
 * this file's own future diffs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  decide,
  parseArgs,
  resolveFlowRoot,
} from "./flow-conflict-marker-check";

const HEAD_MARKER = ["<", "<", "<", "<", "<", "<", "<"].join("");
const TAIL_MARKER = [">", ">", ">", ">", ">", ">", ">"].join("");
const EQUALS_LINE = "=".repeat(7);

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

const here = import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = path.join(here, "flow-conflict-marker-check.ts");

function gitc(cwd: string, args: string[]) {
  return spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

function initRepo(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "flow-conflict-marker-check-"),
  );
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  gitc(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

const scratchDirs: string[] = [];
function makeRepo(): string {
  const dir = initRepo();
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(cwd: string) {
  return spawnSync("bun", [SCRIPT_PATH, "--committed"], {
    cwd,
    encoding: "utf8",
  });
}

// --- Pure unit tests -------------------------------------------------

describe(parseArgs, () => {
  it("bare invocation errors (--committed required)", () => {
    expect(parseArgs([])).toEqual({ error: "--committed is required" });
  });

  it("accepts --committed alone", () => {
    expect(parseArgs(["--committed"])).toEqual({ mode: "committed" });
  });

  it("rejects any extra argument", () => {
    const result = parseArgs(["--committed", "extra"]);
    expect("error" in result).toBe(true);
  });

  it("rejects an unrecognized flag", () => {
    const result = parseArgs(["--json"]);
    expect("error" in result).toBe(true);
  });
});

describe(decide, () => {
  it("grep exitCode 1 (no match anywhere) -> clean, no subprocess needed for touched", () => {
    const result = decide(
      { stdout: "", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
    );
    expect(result).toEqual({ verdict: "clean", blocking: [], preExisting: [] });
  });

  it("grep exitCode > 1 -> error, decide never reads touched", () => {
    const result = decide(
      { stdout: "", exitCode: 128 },
      { stdout: "", stderr: "", exitCode: 0 },
    );
    expect(result.verdict).toBe("error");
    expect(result.message).toContain("128");
  });

  it("grep exitCode 0 but git show (-m) failed -> error", () => {
    const result = decide(
      { stdout: `HEAD:f.txt:1:${HEAD_MARKER} HEAD`, exitCode: 0 },
      { stdout: "", stderr: "fatal: bad revision", exitCode: 128 },
    );
    expect(result.verdict).toBe("error");
    expect(result.message).toContain("bad revision");
  });

  it("grep exitCode 0, a hit inside the touched-file set -> blocking", () => {
    const result = decide(
      { stdout: `HEAD:f.txt:1:${HEAD_MARKER} HEAD`, exitCode: 0 },
      { stdout: "f.txt\n", stderr: "", exitCode: 0 },
    );
    expect(result.verdict).toBe("blocking");
    expect(result.blocking).toHaveLength(1);
    expect(result.preExisting).toHaveLength(0);
  });

  it("grep exitCode 0, a hit outside the touched-file set -> clean with a pre-existing note", () => {
    const result = decide(
      { stdout: `HEAD:legacy.txt:1:${HEAD_MARKER} orphan`, exitCode: 0 },
      { stdout: "other.txt\n", stderr: "", exitCode: 0 },
    );
    expect(result.verdict).toBe("clean");
    expect(result.blocking).toHaveLength(0);
    expect(result.preExisting).toHaveLength(1);
  });
});

describe(resolveFlowRoot, () => {
  it('(10) returns a named error for a dir whose package.json .name is not "flow"', () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "not-flow" }),
    );
    fs.mkdirSync(path.join(dir, "bin"));
    const fakeScript = path.join(dir, "bin", "flow-conflict-marker-check.ts");
    const result = resolveFlowRoot(fakeScript);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("does not contain a flow checkout");
      expect(result.error).toContain(dir);
    }
  });

  it("returns an error when package.json itself is missing", () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "bin"));
    const fakeScript = path.join(dir, "bin", "flow-conflict-marker-check.ts");
    expect("error" in resolveFlowRoot(fakeScript)).toBe(true);
  });

  it("returns an error when bin/ is missing even with a correctly-named package.json", () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "flow" }),
    );
    const fakeScript = path.join(dir, "bin", "flow-conflict-marker-check.ts");
    expect("error" in resolveFlowRoot(fakeScript)).toBe(true);
  });

  it("succeeds for a dir with a flow-named package.json and a bin/ directory", () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "flow" }),
    );
    fs.mkdirSync(path.join(dir, "bin"));
    const fakeScript = path.join(dir, "bin", "flow-conflict-marker-check.ts");
    expect(resolveFlowRoot(fakeScript)).toEqual({ root: dir });
  });

  it.skipIf(process.platform === "win32")(
    "(9) LOGICAL-VS-PHYSICAL — a symlinked skill dir resolves correctly only via its physical (realpath) form",
    () => {
      const realRoot = makeRepo();
      fs.writeFileSync(
        path.join(realRoot, "package.json"),
        JSON.stringify({ name: "flow" }),
      );
      fs.mkdirSync(path.join(realRoot, "bin"));
      // realpathSync (below) needs a real target file to resolve through.
      fs.writeFileSync(
        path.join(realRoot, "bin", "flow-conflict-marker-check.ts"),
        "",
      );

      const elsewhere = fs.mkdtempSync(
        path.join(os.tmpdir(), "flow-conflict-marker-check-symlink-"),
      );
      scratchDirs.push(elsewhere);
      const linkedBin = path.join(elsewhere, "bin");
      fs.symlinkSync(path.join(realRoot, "bin"), linkedBin, "dir");

      const logicalScript = path.join(
        linkedBin,
        "flow-conflict-marker-check.ts",
      );
      // Logical (path.resolve, no realpath): the symlink's OWN parent
      // (`elsewhere`) has no package.json/bin of its own, so this fails.
      expect("error" in resolveFlowRoot(logicalScript)).toBe(true);

      // Physical (realpath-then-resolve): lands back on the real root,
      // which does contain package.json + bin/. Compare against
      // `fs.realpathSync(realRoot)` too — on macOS `/var` is itself a
      // symlink to `/private/var`, so `os.tmpdir()`'s un-realpath'd form
      // would otherwise mismatch the realpath'd-through-the-symlink result.
      const physicalScript = fs.realpathSync(logicalScript);
      expect(resolveFlowRoot(physicalScript)).toEqual({
        root: fs.realpathSync(realRoot),
      });
    },
  );
});

// --- Scratch-repo integration tests -----------------------------------

describe.skipIf(!bunOnPath)(
  "integration: flow-conflict-marker-check --committed against real git fixtures",
  () => {
    it("(3) a clean repo with no markers -> exit 0, verdict: clean", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "f.txt"), "hello\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "feat: add f"]);

      const result = runCli(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("verdict: clean");
    });

    it("(1) a committed marker in a merge-touched file -> exit 1, BLOCKING names the path", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "add f"]);
      gitc(dir, ["checkout", "-q", "-b", "topic"]);
      fs.writeFileSync(path.join(dir, "f.txt"), "topic version\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "topic edits f"]);
      gitc(dir, ["checkout", "-q", "main"]);
      fs.writeFileSync(path.join(dir, "f.txt"), "main version\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "main edits f"]);
      gitc(dir, ["checkout", "-q", "topic"]);
      gitc(dir, ["merge", "--no-edit", "main"]);
      // Botched resolution: markers left in place.
      fs.writeFileSync(
        path.join(dir, "f.txt"),
        [
          `${HEAD_MARKER} HEAD`,
          "topic version",
          EQUALS_LINE,
          "main version",
          `${TAIL_MARKER} main`,
          "",
        ].join("\n"),
      );
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, [
        "commit",
        "--no-verify",
        "-q",
        "-m",
        "chore: merge main into topic (botched)",
      ]);

      const result = runCli(dir);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("BLOCKING f.txt:");
      expect(result.stdout).toContain("verdict: blocking");
    });

    it("(2) TOMBSTONE — git diff --check on the same post-commit fixture exits 0 with empty output", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\nc\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "base"]);
      fs.writeFileSync(
        path.join(dir, "f.txt"),
        [`${HEAD_MARKER} HEAD`, "b", EQUALS_LINE, "c", `${TAIL_MARKER} x`, ""].join(
          "\n",
        ),
      );
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "--no-verify", "-q", "-m", "chore: botched"]);

      const check = spawnSync("git", ["diff", "--check"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(check.status).toBe(0);
      expect(check.stdout.trim()).toBe("");
    });

    it("(4) LAYER SPLIT — git diff --check catches a lone ======= pre-commit; our narrower committed-tree pattern does not", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\nc\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "base"]);

      // Unstaged worktree edit: <<<<<<< and >>>>>>> removed, a lone
      // ======= left mid-file (an `interleave` resolution gone wrong).
      fs.writeFileSync(
        path.join(dir, "f.txt"),
        ["a", EQUALS_LINE, "c", ""].join("\n"),
      );
      const preCommitCheck = spawnSync("git", ["diff", "--check", "--", "f.txt"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(preCommitCheck.status).not.toBe(0);
      expect(preCommitCheck.stdout).toContain("leftover conflict marker");

      // Commit the same (still-broken) content, then confirm our CLI's
      // narrower pattern (no `=======`) reports it clean — Layer 1 is the
      // only layer that would have caught this.
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "chore: partial resolution"]);
      const result = runCli(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("verdict: clean");
      expect(result.stdout).not.toContain("BLOCKING");
    });

    it("(5) `-m` IS LOAD-BEARING — a one-sided merge resolution is invisible to `git show` without -m", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "add f"]);
      gitc(dir, ["checkout", "-q", "-b", "topic"]);
      fs.writeFileSync(path.join(dir, "f.txt"), "topic version\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "topic edits f"]);
      gitc(dir, ["checkout", "-q", "main"]);
      fs.writeFileSync(path.join(dir, "f.txt"), "main version\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "main edits f"]);
      gitc(dir, ["checkout", "-q", "topic"]);
      gitc(dir, ["merge", "--no-edit", "main"]);
      // prefer-incoming: take main's version verbatim, so the merge tree's
      // f.txt equals parent2 (main) but still differs from parent1 (topic).
      fs.writeFileSync(path.join(dir, "f.txt"), "main version\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, [
        "commit",
        "--no-verify",
        "-q",
        "-m",
        "chore: merge main into topic",
      ]);

      const noM = spawnSync(
        "git",
        ["show", "--name-only", "--format=", "HEAD"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(noM.stdout.trim()).toBe("");

      const withM = spawnSync(
        "git",
        ["show", "--name-only", "--format=", "-m", "HEAD"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(withM.stdout).toContain("f.txt");
    });

    it("(6) REV PREFIX — raw grep output starts `HEAD:`, and parseGitGrepOutput strips it", async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "base"]);
      fs.writeFileSync(path.join(dir, "f.txt"), `${HEAD_MARKER} HEAD\na\n`);
      gitc(dir, ["add", "f.txt"]);
      gitc(dir, ["commit", "-q", "-m", "chore: leaves a marker"]);

      const raw = spawnSync(
        "git",
        [
          "grep",
          "--full-name",
          "-nE",
          "^(<{7}|>{7})( |$)",
          "HEAD",
          "--",
          ":/",
        ],
        { cwd: dir, encoding: "utf8" },
      );
      expect(raw.status).toBe(0);
      expect(raw.stdout.startsWith("HEAD:")).toBe(true);

      const { parseGitGrepOutput } = await import("./lib/conflict-markers");
      const hits = parseGitGrepOutput(raw.stdout, "HEAD");
      expect(hits[0].path).toBe("f.txt");
    });

    it("(7) a pre-existing hit outside the merge -> exit 0, labelled PRE-EXISTING", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "legacy.txt"), `${HEAD_MARKER} HEAD\norphan\n`);
      gitc(dir, ["add", "legacy.txt"]);
      gitc(dir, ["commit", "-q", "-m", "legacy: leftover marker, never fixed"]);
      fs.writeFileSync(path.join(dir, "other.txt"), "x\n");
      gitc(dir, ["add", "other.txt"]);
      gitc(dir, ["commit", "-q", "-m", "feat: unrelated change"]);

      const result = runCli(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PRE-EXISTING legacy.txt:");
      expect(result.stdout).toContain("verdict: clean");
    });

    it("(8) SOURCE-TREE INVOCATION — invoking the real script with a foreign cwd resolves its own root independent of cwd", () => {
      const cleanDir = makeRepo();
      fs.writeFileSync(path.join(cleanDir, "f.txt"), "hello\n");
      gitc(cleanDir, ["add", "f.txt"]);
      gitc(cleanDir, ["commit", "-q", "-m", "feat: add f"]);

      const markerDir = makeRepo();
      fs.writeFileSync(path.join(markerDir, "f.txt"), "a\n");
      gitc(markerDir, ["add", "f.txt"]);
      gitc(markerDir, ["commit", "-q", "-m", "base"]);
      fs.writeFileSync(path.join(markerDir, "f.txt"), `${HEAD_MARKER} HEAD\na\n`);
      gitc(markerDir, ["add", "f.txt"]);
      gitc(markerDir, ["commit", "-q", "-m", "chore: leaves a marker"]);

      expect(runCli(cleanDir).status).toBe(0);
      expect(runCli(markerDir).status).toBe(1);
    });
  },
);
