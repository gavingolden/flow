import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractCommand,
  runTestSteps,
  type RunTestStepsOpts,
} from "./run-test-steps";
import { parseTestSteps } from "./test-steps-parse";

const MARKER = "<!-- flow:evidence -->";

function setup(body: string): { dir: string; bodyFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "run-test-steps-"));
  const bodyFile = path.join(dir, "body.md");
  writeFileSync(bodyFile, body);
  return { dir, bodyFile };
}

function stubExec(
  map: Record<
    string,
    { output?: string; exitCode?: number; timedOut?: boolean }
  >,
  calls: string[] = [],
): NonNullable<RunTestStepsOpts["exec"]> {
  return (cmd) => {
    calls.push(cmd);
    const r = map[cmd] ?? {};
    return {
      output: r.output ?? `out of ${cmd}\n`,
      exitCode: r.exitCode ?? 0,
      timedOut: r.timedOut ?? false,
    };
  };
}

const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe("extractCommand", () => {
  it("takes a leading code span", () => {
    expect(extractCommand("`npx vitest run x` passes")).toBe(
      "npx vitest run x",
    );
  });
  it("takes the span after a leading Run", () => {
    expect(extractCommand("Run  `test -f a.txt` to confirm")).toBe(
      "test -f a.txt",
    );
  });
  it("returns only the first span", () => {
    expect(extractCommand("`one` then `two`")).toBe("one");
  });
  it("returns null for prose, mid-text spans, and double backticks", () => {
    expect(extractCommand("Check that `x` works")).toBeNull();
    expect(extractCommand("verify the thing")).toBeNull();
    expect(extractCommand("``a b`` works")).toBeNull();
  });
});

describe("runTestSteps", () => {
  it("(a) ticks passes, leaves the failure unticked, never touches SUBJECTIVE", () => {
    const { dir, bodyFile } = setup(
      [
        "## Test Steps",
        "",
        "- [ ] `echo one` prints one",
        "- [ ] `false` should fail",
        "- [ ] SUBJECTIVE: the header looks balanced",
        "- [ ] `echo two` prints two",
        "",
      ].join("\n"),
    );
    const r = runTestSteps({
      bodyFile,
      worktree: dir,
      exec: stubExec({
        "echo one": { output: "one\n" },
        false: { output: "boom\n", exitCode: 1 },
        "echo two": { output: "two\n" },
      }),
    });
    const body = readFileSync(bodyFile, "utf8");
    expect(r.total).toBe(4);
    expect(r.ran).toBe(3);
    expect(r.passed).toBe(2);
    expect(r.skipped.map((s) => s.reason)).toEqual(["human-only"]);
    expect(body).toContain("- [x] `echo one` prints one");
    expect(body).toContain("- [x] `echo two` prints two");
    expect(body).toContain("- [ ] `false` should fail");
    expect(body).toContain("- [ ] SUBJECTIVE: the header looks balanced");
    expect(count(body, MARKER)).toBe(3);
    expect(body).toContain("FAILED exit 1");
    expect(body.indexOf("- [ ] SUBJECTIVE")).toBeLessThan(
      body.indexOf("echo two"),
    );
    const sub = body.split("\n").findIndex((l) => l.includes("SUBJECTIVE"));
    expect(body.split("\n")[sub + 1]).not.toContain(MARKER);
  });

  it("writes the evidence and exit files named by run index", () => {
    const { dir, bodyFile } = setup("## Test Steps\n\n- [ ] `a`\n- [ ] `b`\n");
    runTestSteps({
      bodyFile,
      worktree: dir,
      exec: stubExec({
        a: { output: "A\n" },
        b: { output: "B\n", exitCode: 3 },
      }),
    });
    const ev = (f: string): string =>
      readFileSync(path.join(dir, ".flow-tmp", f), "utf8");
    expect(ev("evidence-1.txt")).toBe("A\n");
    expect(ev("exit-1")).toBe("0\n");
    expect(ev("evidence-2.txt")).toBe("B\n");
    expect(ev("exit-2")).toBe("3\n");
  });

  it("(b) records a timeout as exit 124 and leaves the box unticked", () => {
    const { dir, bodyFile } = setup("## Test Steps\n\n- [ ] `sleep 999`\n");
    const r = runTestSteps({
      bodyFile,
      worktree: dir,
      exec: stubExec({
        "sleep 999": { output: "partial\n", exitCode: 124, timedOut: true },
      }),
    });
    expect(r.passed).toBe(0);
    expect(r.failed).toEqual([
      {
        line: 3,
        command: "sleep 999",
        exitCode: 124,
        timedOut: true,
        evidenceFile: path.join(dir, ".flow-tmp", "evidence-1.txt"),
      },
    ]);
    const body = readFileSync(bodyFile, "utf8");
    expect(body).toContain("- [ ] `sleep 999`");
    expect(body).toContain("FAILED exit 124");
  });

  it("passes the timeout in milliseconds to exec", () => {
    const { dir, bodyFile } = setup("## Test Steps\n\n- [ ] `a`\n");
    const seen: number[] = [];
    runTestSteps({
      bodyFile,
      worktree: dir,
      timeoutSec: 7,
      exec: (_cmd, cwd, timeoutMs) => {
        expect(cwd).toBe(dir);
        seen.push(timeoutMs);
        return { output: "", exitCode: 0, timedOut: false };
      },
    });
    expect(seen).toEqual([7000]);
  });

  it("caps an item's time limit at the remaining budget", () => {
    const { dir, bodyFile } = setup("## Test Steps\n\n- [ ] `a`\n");
    let t = 0;
    const seen: number[] = [];
    runTestSteps({
      bodyFile,
      worktree: dir,
      timeoutSec: 240,
      budgetSec: 100,
      now: () => {
        const v = t;
        t += 30000;
        return v;
      },
      exec: (_cmd, _cwd, ms) => {
        seen.push(ms);
        return { output: "", exitCode: 0, timedOut: false };
      },
    });
    expect(seen[0]).toBeLessThanOrEqual(100000);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("(c) skips remaining command items once the budget is exceeded", () => {
    const { dir, bodyFile } = setup(
      "## Test Steps\n\n- [ ] `a`\n- [ ] `b`\n- [ ] `c`\n",
    );
    let t = 0;
    const calls: string[] = [];
    const r = runTestSteps({
      bodyFile,
      worktree: dir,
      budgetSec: 10,
      now: () => {
        const v = t;
        t += 4000;
        return v;
      },
      exec: stubExec({}, calls),
    });
    expect(calls).toEqual(["a", "b"]);
    expect(r.ran).toBe(2);
    expect(r.skipped.map((s) => s.reason)).toEqual(["budget"]);
    const body = readFileSync(bodyFile, "utf8");
    expect(body).toContain("- [x] `a`");
    expect(body).toContain("- [x] `b`");
    expect(body).toContain("- [ ] `c`");
  });

  it("(d) gives each of two byte-identical lines its own tick and evidence, metacharacters included", () => {
    const cmd = "[ \"$(echo a)\" = a ] && grep -c '^x.*$' f || true";
    const { dir, bodyFile } = setup(
      [
        "## Test Steps",
        "",
        `- [ ] \`${cmd}\``,
        `- [ ] \`${cmd}\``,
        "- [ ] `tail`",
        "",
      ].join("\n"),
    );
    let n = 0;
    const r = runTestSteps({
      bodyFile,
      worktree: dir,
      exec: (c) => {
        n++;
        return {
          output: `run ${n} of ${c.slice(0, 3)}\n`,
          exitCode: 0,
          timedOut: false,
        };
      },
    });
    const body = readFileSync(bodyFile, "utf8");
    expect(r.ticked).toHaveLength(3);
    expect(count(body, MARKER)).toBe(3);
    expect(count(body, "- [x]")).toBe(3);
    expect(count(body, "- [ ]")).toBe(0);
    const lines = body.split("\n");
    const firstIdx = lines.findIndex((l) => l.includes('[ "$(echo a)"'));
    const secondIdx = lines.findIndex(
      (l, i) => i > firstIdx && l.includes('[ "$(echo a)"'),
    );
    expect(lines.slice(firstIdx, secondIdx).join("\n")).toContain("run 1 of");
    expect(lines.slice(firstIdx, secondIdx).join("\n")).not.toContain(
      "run 2 of",
    );
    expect(lines.slice(secondIdx).join("\n")).toContain("run 2 of");
    expect(lines.slice(secondIdx).join("\n")).toContain("run 3 of");
  });

  it("(e) reports post-rewrite lines that point at the right items", () => {
    const { dir, bodyFile } = setup(
      [
        "## Test Steps",
        "",
        "- [ ] `ok1`",
        "- [ ] `bad`",
        "- [ ] `ok2`",
        "- [ ] `bad2`",
        "- [ ] Browser: open the page",
        "",
      ].join("\n"),
    );
    const r = runTestSteps({
      bodyFile,
      worktree: dir,
      exec: stubExec({ bad: { exitCode: 2 }, bad2: { exitCode: 5 } }),
    });
    const lines = readFileSync(bodyFile, "utf8").split("\n");
    expect(r.failed.map((f) => f.command)).toEqual(["bad", "bad2"]);
    for (const f of r.failed)
      expect(lines[f.line - 1]).toContain(`\`${f.command}\``);
    for (const l of r.ticked)
      expect(lines[l - 1]).toMatch(/^- \[x\] `ok[12]`$/);
    expect(r.skipped).toHaveLength(1);
    expect(lines[r.skipped[0].line - 1]).toContain("Browser: open the page");
    expect(r.skipped[0]).toMatchObject({ kind: "browser", reason: "browser" });
  });

  it("(f) re-running a fixed item via only ticks it and replaces its evidence block", () => {
    const { dir, bodyFile } = setup(
      "## Test Steps\n\n- [ ] `ok`\n- [ ] `flaky`\n",
    );
    const first = runTestSteps({
      bodyFile,
      worktree: dir,
      exec: stubExec({ flaky: { output: "nope\n", exitCode: 1 } }),
    });
    expect(first.failed).toHaveLength(1);
    const calls: string[] = [];
    const second = runTestSteps({
      bodyFile,
      worktree: dir,
      only: [first.failed[0].line],
      exec: stubExec({ flaky: { output: "fixed\n" } }, calls),
    });
    const body = readFileSync(bodyFile, "utf8");
    expect(calls).toEqual(["flaky"]);
    expect(second).toMatchObject({
      ran: 1,
      passed: 1,
      failed: [],
      skipped: [],
    });
    expect(second.total).toBe(2);
    expect(body).toContain("- [x] `flaky`");
    expect(count(body, MARKER)).toBe(2);
    expect(body).toContain("fixed");
    expect(body).not.toContain("nope");
    expect(second.ticked).toEqual([first.failed[0].line]);
  });

  it("(h) skips already-checked, browser, and prose items with the right reason", () => {
    const { dir, bodyFile } = setup(
      [
        "## Test Steps",
        "",
        "- [x] `done`",
        "- [ ] Browser: click through",
        "- [ ] check the thing by eye",
        "- [ ] DECISION: pick one",
        "- [ ] Check that `x` works",
        "",
      ].join("\n"),
    );
    const calls: string[] = [];
    const r = runTestSteps({
      bodyFile,
      worktree: dir,
      exec: stubExec({}, calls),
    });
    expect(calls).toEqual([]);
    expect(r.ran).toBe(0);
    expect(r.total).toBe(5);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      "already-checked",
      "browser",
      "prose",
      "human-only",
      "prose",
    ]);
    expect(readFileSync(bodyFile, "utf8")).not.toContain(MARKER);
  });

  it("leaves the body untouched when nothing ran", () => {
    const body = "# PR\n\nno steps here\n";
    const { dir, bodyFile } = setup(body);
    const r = runTestSteps({ bodyFile, worktree: dir, exec: stubExec({}) });
    expect(r).toMatchObject({ total: 0, ran: 0, passed: 0 });
    expect(readFileSync(bodyFile, "utf8")).toBe(body);
  });

  it("keeps the rewritten body parseable with every run item still an item", () => {
    const { dir, bodyFile } = setup(
      "## Test Steps\n\n- [ ] `a`\n- [ ] `b`\n\n## Notes\n\ntext\n",
    );
    runTestSteps({ bodyFile, worktree: dir, exec: stubExec({}) });
    const { steps } = parseTestSteps(readFileSync(bodyFile, "utf8"));
    expect(steps.filter((s) => s.checked && s.hasEvidence)).toHaveLength(2);
    expect(readFileSync(bodyFile, "utf8")).toContain("## Notes\n\ntext\n");
  });
});
