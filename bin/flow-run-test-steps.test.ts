import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./flow-run-test-steps";

const CLI = path.resolve(__dirname, "flow-run-test-steps.ts");

function cli(
  args: string[],
  env: Record<string, string> = {},
): { code: number | null; out: string; err: string } {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setup(items: string[]): { dir: string; bodyFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-run-test-steps-"));
  const bodyFile = path.join(dir, "body.md");
  writeFileSync(
    bodyFile,
    ["## Test Steps", "", ...items.map((i) => `- [ ] ${i}`), ""].join("\n"),
  );
  return { dir, bodyFile };
}

describe("parseArgs", () => {
  it("applies the defaults", () => {
    expect(parseArgs(["--body-file", "b.md"])).toMatchObject({
      bodyFile: "b.md",
      timeoutSec: 240,
      budgetSec: 540,
    });
  });
  it("parses --only as a comma list of positive ints", () => {
    expect(parseArgs(["--body-file", "b", "--only", "3,10"])).toMatchObject({
      only: [3, 10],
    });
    expect(parseArgs(["--body-file", "b", "--only", "3,x"])).toHaveProperty(
      "error",
    );
    expect(parseArgs(["--body-file", "b", "--only", "0"])).toHaveProperty(
      "error",
    );
  });
  it("rejects unknown flags and missing values", () => {
    expect(parseArgs(["--nope", "1"])).toHaveProperty("error");
    expect(parseArgs(["--body-file"])).toHaveProperty("error");
  });
});

describe("flow-run-test-steps CLI", () => {
  it("exits 2 when --body-file is missing", () => {
    const r = cli([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--body-file is required");
  });

  it("exits 2 on a non-numeric --timeout-sec", () => {
    const { bodyFile } = setup(["`true`"]);
    const r = cli(["--body-file", bodyFile, "--timeout-sec", "abc"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--timeout-sec");
  });

  it("exits 2 on a missing body file", () => {
    const r = cli(["--body-file", "/nonexistent/body.md"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot read");
  });

  it("runs a passing and a failing item for real and rewrites the body", () => {
    const { dir, bodyFile } = setup(["`true`", "`exit 3`"]);
    const r = cli(["--body-file", bodyFile, "--worktree", dir]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({
      version: 1,
      total: 2,
      ran: 2,
      passed: 1,
      skipped: [],
    });
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({
      command: "exit 3",
      exitCode: 3,
      timedOut: false,
    });
    const body = readFileSync(bodyFile, "utf8");
    expect(body).toContain("- [x] `true`");
    expect(body).toContain("- [ ] `exit 3`");
    expect(body).toContain("FAILED exit 3");
    expect(body.split("\n")[out.failed[0].line - 1]).toContain("`exit 3`");
    expect(readFileSync(path.join(dir, ".flow-tmp", "exit-2"), "utf8")).toBe(
      "3\n",
    );
  });

  it("records a real timeout as exit 124", () => {
    const { dir, bodyFile } = setup(["`sleep 5`"]);
    const t0 = Date.now();
    const r = cli([
      "--body-file",
      bodyFile,
      "--worktree",
      dir,
      "--timeout-sec",
      "1",
    ]);
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.failed[0]).toMatchObject({ exitCode: 124, timedOut: true });
    expect(readFileSync(bodyFile, "utf8")).toContain("- [ ] `sleep 5`");
  });

  it("strips FLOW_SLUG and TMUX_PANE from the item's environment", () => {
    const { dir, bodyFile } = setup(["`env > envdump.txt`"]);
    const r = cli(["--body-file", bodyFile, "--worktree", dir], {
      FLOW_SLUG: "leak",
      TMUX_PANE: "leak",
    });
    expect(r.code).toBe(0);
    const dump = path.join(dir, "envdump.txt");
    expect(existsSync(dump)).toBe(true);
    const text = readFileSync(dump, "utf8");
    expect(text).toContain("PATH=");
    expect(text).not.toContain("FLOW_SLUG");
    expect(text).not.toContain("TMUX_PANE");
  });
});
