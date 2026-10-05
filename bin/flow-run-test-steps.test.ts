import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./flow-run-test-steps";
import { defaultExec, runTestSteps, type ExecFn } from "./lib/run-test-steps";

type Call = { argv: string[]; timeoutMs?: number; bodyAtCall?: string };

let worktree: string;
let bodyFile: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "run-test-steps-"));
  bodyFile = path.join(worktree, ".flow-tmp", "body.md");
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

function bodyOf(items: string[]): string {
  return [
    "## TLDR",
    "",
    "A change.",
    "",
    "## Test Steps",
    "",
    ...items,
    "",
    "## Notes",
    "",
    "tail",
    "",
  ].join("\n");
}

/** Fake gh/flow-md-validate/bash. `commands` maps a bash -c command to
 * [exitCode, output]; `advanceMs` moves the injected clock per bash run. */
function harness(
  body: string,
  opts: {
    commands?: Record<string, [number, string]>;
    checkExit?: number;
    advanceMs?: number;
    viewExit?: number;
    crossRepo?: boolean;
    timeoutOn?: string[];
  } = {},
) {
  const calls: Call[] = [];
  let t = 0;
  const exec: ExecFn = (argv, o) => {
    const call: Call = { argv, timeoutMs: o?.timeoutMs };
    calls.push(call);
    if (argv[0] === "gh" && argv[2] === "view") {
      return {
        stdout: JSON.stringify({ body, isCrossRepository: opts.crossRepo }),
        stderr: "boom",
        exitCode: opts.viewExit ?? 0,
      };
    }
    if (argv[0] === "bash") {
      t += opts.advanceMs ?? 0;
      if (opts.timeoutOn?.includes(argv[2])) {
        return {
          stdout: "partial\n",
          stderr: "",
          exitCode: 124,
          timedOut: true,
        };
      }
      const [code, out] = opts.commands?.[argv[2]] ?? [0, `ran ${argv[2]}\n`];
      return { stdout: out, stderr: "", exitCode: code };
    }
    if (argv[0] === "flow-md-validate") {
      call.bodyAtCall = fs.readFileSync(argv[2], "utf8");
      return {
        stdout: "",
        stderr: "",
        exitCode: argv[1] === "--check-pr-body" ? (opts.checkExit ?? 0) : 0,
      };
    }
    if (argv[0] === "gh" && argv[2] === "edit") {
      call.bodyAtCall = fs.readFileSync(
        argv[argv.indexOf("--body-file") + 1],
        "utf8",
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    throw new Error(`unexpected exec: ${argv.join(" ")}`);
  };
  return { calls, exec, now: () => t };
}

const edits = (calls: Call[]) =>
  calls.filter((c) => c.argv[0] === "gh" && c.argv[2] === "edit");

describe("runTestSteps", () => {
  it("ticks passes with evidence, annotates a failure, leaves SUBJECTIVE/prose, pushes once after the repair", async () => {
    const body = bodyOf([
      "- [ ] Run `cmd-pass-1` and expect success",
      "- [ ] Run `cmd-fail` and expect success",
      "- [ ] SUBJECTIVE: the page feels calm",
      "- [ ] Check that the notes read well",
      "- [ ] Run `cmd-pass-2`",
    ]);
    const h = harness(body, {
      commands: { "cmd-fail": [3, "bad thing\nlast line\n"] },
    });
    const env = await runTestSteps({
      pr: 7,
      worktree,
      budgetSec: 540,
      exec: h.exec,
      now: h.now,
    });

    expect(env).toMatchObject({
      total: 3,
      uncheckedTotal: 5,
      ran: 3,
      passed: 2,
      bodyPushed: true,
      pushSkippedReason: null,
      pending: [],
    });
    expect(env.failed).toEqual([
      {
        index: 2,
        command: "cmd-fail",
        exitCode: 3,
        tail: "bad thing\nlast line",
      },
    ]);
    expect(env.notRunnable).toEqual([
      { index: 3, kind: "subjective", text: "SUBJECTIVE: the page feels calm" },
      { index: 4, kind: "prose", text: "Check that the notes read well" },
    ]);

    const pushed = edits(h.calls);
    expect(pushed).toHaveLength(1);
    const text = pushed[0].bodyAtCall!;
    expect(text).toContain("- [x] Run `cmd-pass-1` and expect success");
    expect(text).toContain("- [ ] Run `cmd-fail` and expect success");
    expect(text).toContain("- [x] Run `cmd-pass-2`");
    expect(text).toContain("- [ ] SUBJECTIVE: the page feels calm");
    expect(text).toContain("- [ ] Check that the notes read well");
    expect(text.match(/<!-- flow:evidence -->/g)).toHaveLength(3);
    expect(text).toContain("FAILED exit 3");

    // Repair-before-push: fix, then check, then the single edit, in order.
    const order = h.calls
      .map((c) => c.argv.slice(0, 2).join(" "))
      .filter((s) => /flow-md-validate|gh pr/.test(s));
    expect(order).toEqual([
      "gh pr",
      "flow-md-validate --fix-pr-body",
      "flow-md-validate --check-pr-body",
      "gh pr",
    ]);
    const lastValidate = h.calls.findLastIndex(
      (c) => c.argv[0] === "flow-md-validate",
    );
    expect(h.calls.indexOf(pushed[0])).toBe(lastValidate + 1);

    expect(
      fs.readFileSync(path.join(worktree, ".flow-tmp/evidence-2.txt"), "utf8"),
    ).toBe("bad thing\nlast line\n");
    expect(
      fs.readFileSync(path.join(worktree, ".flow-tmp/exit-2"), "utf8").trim(),
    ).toBe("3");
    expect(
      fs.readFileSync(path.join(worktree, ".flow-tmp/exit-1"), "utf8").trim(),
    ).toBe("0");
  });

  it("reads the body with --json body and never --jq", async () => {
    const h = harness(bodyOf(["- [ ] Run `x`"]));
    await runTestSteps({
      pr: 9,
      worktree,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(h.calls[0].argv).toEqual([
      "gh",
      "pr",
      "view",
      "9",
      "--json",
      "body,isCrossRepository",
    ]);
    expect(h.calls.some((c) => c.argv.includes("--jq"))).toBe(false);
  });

  it("targets an item carrying an inline comment, and duplicates one at a time", async () => {
    const body = bodyOf([
      "- [ ] Run `dup` <!-- author note (with [regex] chars) -->",
      "- [ ] Run `dup`",
      "- [ ] Run `dup`",
    ]);
    const h = harness(body, {
      commands: {},
    });
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 540,
      exec: h.exec,
      now: h.now,
    });
    expect(env.passed).toBe(3);
    const text = edits(h.calls)[0].bodyAtCall!;
    expect(text).toContain(
      "- [x] Run `dup` <!-- author note (with [regex] chars) -->",
    );
    expect(text.match(/- \[x\] Run `dup`/g)).toHaveLength(3);
    expect(text.match(/<!-- flow:evidence -->/g)).toHaveLength(3);
    expect(text).not.toContain("- [ ]");
  });

  it("annotates the failing duplicate, not an earlier identical line", async () => {
    // Both lines are identical; the first fails (stays unticked, evidence under
    // it), then the second passes and must tick ITSELF, not the first.
    const body = bodyOf(["- [ ] Run `flaky`", "- [ ] Run `flaky`"]);
    let n = 0;
    const base = harness(body);
    const exec: ExecFn = (argv, o) =>
      argv[0] === "bash"
        ? (base.exec(argv, o),
          { stdout: "o\n", stderr: "", exitCode: n++ === 0 ? 1 : 0 })
        : base.exec(argv, o);
    const env = await runTestSteps({ pr: 1, worktree, budgetSec: 540, exec });
    expect(env.failed.map((f) => f.index)).toEqual([1]);
    const lines = edits(base.calls)[0].bodyAtCall!.split("\n");
    const first = lines.findIndex((l) => l.includes("Run `flaky`"));
    expect(lines[first]).toContain("- [ ]");
    const second = lines.findIndex(
      (l, i) => i > first && l.includes("Run `flaky`"),
    );
    expect(lines[second]).toContain("- [x]");
  });

  it("leaves unstarted items pending once the budget is spent, and --only re-runs exactly those", async () => {
    const body = bodyOf(["- [ ] Run `a`", "- [ ] Run `b`", "- [ ] Run `c`"]);
    const h = harness(body, { advanceMs: 200_000 });
    const first = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 300,
      exec: h.exec,
      now: h.now,
    });
    expect(first.ran).toBe(2);
    expect(first.pending).toEqual([{ index: 3, command: "c" }]);
    expect(first.total).toBe(3);
    const timeouts = h.calls
      .filter((c) => c.argv[0] === "bash")
      .map((c) => c.timeoutMs);
    expect(timeouts).toEqual([300_000, 100_000]);

    const h2 = harness(body, { advanceMs: 1000 });
    const second = await runTestSteps({
      pr: 1,
      worktree,
      only: [3],
      budgetSec: 300,
      exec: h2.exec,
      now: h2.now,
    });
    expect(second.total).toBe(1);
    expect(second.ran).toBe(1);
    expect(
      h2.calls.filter((c) => c.argv[0] === "bash").map((c) => c.argv[2]),
    ).toEqual(["c"]);
  });

  it("starts from a seeded body.md when --body-file is passed, keeping unpushed edits and prior ticks", async () => {
    const remote = bodyOf(["- [ ] Run `a`", "- [ ] Run `b`"]);
    const local = bodyOf([
      "- [x] Run `a`",
      "- [ ] Run `b`",
      "- [ ] Check that the drafted 11e item reads well",
    ]);
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, local);
    const h = harness(remote);
    const env = await runTestSteps({
      pr: 1,
      worktree,
      only: [2],
      bodyFile,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.ran).toBe(1);
    const text = edits(h.calls)[0].bodyAtCall!;
    expect(text).toContain("- [x] Run `a`");
    expect(text).toContain("- [x] Run `b`");
    expect(text).toContain("- [ ] Check that the drafted 11e item reads well");
  });

  it("falls back to the GitHub body when --body-file does not exist", async () => {
    const h = harness(bodyOf(["- [ ] Run `a`"]));
    const env = await runTestSteps({
      pr: 1,
      worktree,
      bodyFile: path.join(worktree, ".flow-tmp", "missing.md"),
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.passed).toBe(1);
  });

  it("replaces an existing FAILED evidence block on a --only re-run instead of stacking a second one", async () => {
    const body = bodyOf(["- [ ] Run `flaky`", "- [ ] Run `other`"]);
    const h1 = harness(body, { commands: { flaky: [2, "boom\n"] } });
    const first = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      exec: h1.exec,
      now: h1.now,
    });
    expect(first.failed.map((f) => f.index)).toEqual([1]);
    const afterFirst = edits(h1.calls)[0].bodyAtCall!;
    expect(afterFirst).toContain("FAILED exit 2");

    const h2 = harness(afterFirst);
    const second = await runTestSteps({
      pr: 1,
      worktree,
      only: [1],
      budgetSec: 60,
      exec: h2.exec,
      now: h2.now,
    });
    expect(second.passed).toBe(1);
    const text = edits(h2.calls)[0].bodyAtCall!;
    expect(text).toContain("- [x] Run `flaky`");
    expect(text).not.toContain("FAILED exit 2");
    expect(text.match(/<!-- flow:evidence -->/g)).toHaveLength(2);
  });

  it("refuses to run a cross-repository PR unless --allow-cross-repo is passed", async () => {
    const body = bodyOf(["- [ ] Run `a`", "- [ ] Run `b`"]);
    const h = harness(body, { crossRepo: true });
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.ran).toBe(0);
    expect(env.pushSkippedReason).toBe("cross-repository-pr");
    expect(env.pending.map((p) => p.index)).toEqual([1, 2]);
    expect(h.calls.some((c) => c.argv[0] === "bash")).toBe(false);
    expect(edits(h.calls)).toHaveLength(0);

    const h2 = harness(body, { crossRepo: true });
    const allowed = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      allowCrossRepo: true,
      exec: h2.exec,
      now: h2.now,
    });
    expect(allowed.ran).toBe(2);
    expect(allowed.pushSkippedReason).toBeNull();
  });

  it("reports an item killed by the shared budget as pending, with no failure block", async () => {
    const body = bodyOf(["- [ ] Run `a`", "- [ ] Run `slow`"]);
    const h = harness(body, { advanceMs: 200_000, timeoutOn: ["slow"] });
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 300,
      exec: h.exec,
      now: h.now,
    });
    expect(env.failed).toEqual([]);
    expect(env.pending).toEqual([{ index: 2, command: "slow" }]);
    expect(env.ran).toBe(1);
    const text = edits(h.calls)[0].bodyAtCall!;
    expect(text).not.toContain("FAILED");
    expect(text).toContain("- [ ] Run `slow`");
    expect(fs.existsSync(path.join(worktree, ".flow-tmp/evidence-2.txt"))).toBe(
      false,
    );
  });

  it("still reports an item that hits its own 300 s cap as failed", async () => {
    const h = harness(bodyOf(["- [ ] Run `a`", "- [ ] Run `hang`"]), {
      timeoutOn: ["hang"],
    });
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 540,
      exec: h.exec,
      now: h.now,
    });
    expect(env.failed.map((f) => f.exitCode)).toEqual([124]);
    expect(env.pending).toEqual([]);
  });

  it("gives a lone candidate (a --only re-run) the whole remaining budget", async () => {
    const h = harness(bodyOf(["- [ ] Run `a`", "- [ ] Run `b`"]));
    await runTestSteps({
      pr: 1,
      worktree,
      only: [2],
      budgetSec: 540,
      exec: h.exec,
      now: h.now,
    });
    expect(
      h.calls.filter((c) => c.argv[0] === "bash").map((c) => c.timeoutMs),
    ).toEqual([540_000]);
  });

  it("does not push when --check-pr-body fails, and keeps the pre-edit body", async () => {
    const body = bodyOf(["- [ ] Run `x`"]);
    const h = harness(body, { checkExit: 1 });
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.bodyPushed).toBe(false);
    expect(env.pushSkippedReason).toBe("md-validate-failed");
    expect(edits(h.calls)).toHaveLength(0);
    expect(fs.readFileSync(bodyFile, "utf8")).toBe(body);
  });

  it("defers a body with local image refs to flow-review-finalize", async () => {
    const body = bodyOf(["- [ ] Run `x`", "", "![shot](.flow-tmp/shot.png)"]);
    const h = harness(body);
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.bodyPushed).toBe(false);
    expect(env.pushSkippedReason).toBe("local-image-refs-deferred-to-finalize");
    expect(edits(h.calls)).toHaveLength(0);
    expect(fs.readFileSync(bodyFile, "utf8")).toContain("- [x] Run `x`");
  });

  it("counts every unchecked item in uncheckedTotal and skips already-ticked ones", async () => {
    const body = bodyOf([
      "- [x] Run `done`",
      "- [ ] Run `todo`",
      "- [ ] DECISION: confirm scope",
      "- [ ] Browser: open the page",
    ]);
    const h = harness(body);
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.uncheckedTotal).toBe(3);
    expect(env.total).toBe(1);
    expect(env.notRunnable.map((n) => n.kind)).toEqual(["decision", "browser"]);
    expect(h.calls.filter((c) => c.argv[0] === "bash")).toHaveLength(1);
  });

  it("pushes nothing when no item ran", async () => {
    const h = harness(bodyOf(["- [ ] SUBJECTIVE: taste"]));
    const env = await runTestSteps({
      pr: 1,
      worktree,
      budgetSec: 60,
      exec: h.exec,
      now: h.now,
    });
    expect(env.ran).toBe(0);
    expect(env.bodyPushed).toBe(false);
    expect(env.pushSkippedReason).toBe("no-items-ran");
    expect(edits(h.calls)).toHaveLength(0);
  });

  it("throws on a gh read failure", async () => {
    const h = harness("x", { viewExit: 1 });
    await expect(
      runTestSteps({
        pr: 1,
        worktree,
        budgetSec: 60,
        exec: h.exec,
        now: h.now,
      }),
    ).rejects.toThrow(/gh pr view failed/);
  });
});

describe("flow-run-test-steps CLI", () => {
  it("parses flags and defaults the budget to 540", () => {
    expect(parseArgs(["--pr", "3", "--worktree", "/w"])).toEqual({
      pr: 3,
      worktree: "/w",
      only: undefined,
      budgetSec: 540,
      bodyFile: undefined,
      allowCrossRepo: false,
    });
    expect(
      parseArgs([
        "--pr",
        "3",
        "--worktree",
        "/w",
        "--only",
        "1,3",
        "--budget-sec",
        "30",
        "--body-file",
        "/w/.flow-tmp/body.md",
        "--allow-cross-repo",
      ]),
    ).toEqual({
      pr: 3,
      worktree: "/w",
      only: [1, 3],
      budgetSec: 30,
      bodyFile: "/w/.flow-tmp/body.md",
      allowCrossRepo: true,
    });
  });

  it("exits 0 with the JSON envelope on stdout, and 1 on a gh read failure", async () => {
    const h = harness(bodyOf(["- [ ] Run `a`"]));
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => {
      out.push(String(m));
    });
    try {
      expect(await run(["--pr", "1", "--worktree", worktree], h.exec)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(out[0])).toMatchObject({ ran: 1, passed: 1 });

    const bad = harness("x", { viewExit: 1 });
    expect(await run(["--pr", "1", "--worktree", worktree], bad.exec)).toBe(1);
  });

  it("rejects bad args with exit 2", async () => {
    expect(parseArgs([])).toEqual({ error: "--pr is required" });
    expect(parseArgs(["--pr", "x", "--worktree", "/w"])).toEqual({
      error: "invalid --pr value: x",
    });
    expect(parseArgs(["--pr", "1"])).toEqual({
      error: "--worktree is required",
    });
    expect(
      parseArgs(["--pr", "1", "--worktree", "/w", "--only", "1,a"]),
    ).toEqual({ error: "invalid --only value: 1,a" });
    expect(await run(["--bogus"])).toBe(2);
  });
});

describe("defaultExec", () => {
  it("kills the whole process group on timeout, including backgrounded grandchildren", async () => {
    const pidFile = path.join(worktree, "child.pid");
    const r = await defaultExec(
      ["bash", "-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      { cwd: worktree, timeoutMs: 500 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && alive(); i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(alive()).toBe(false);
  });

  it("returns stdout, stderr and the exit code of a normal run", async () => {
    const r = await defaultExec([
      "bash",
      "-c",
      "echo out; echo err >&2; exit 3",
    ]);
    expect(r).toMatchObject({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 3,
      timedOut: false,
    });
  });
});
