import { describe, expect, it, vi } from "vitest";
import {
  ensureLabels,
  parseArgs,
  probeExistingIssue,
  run,
  type GhRunner,
} from "./flow-create-issue";

const ISSUE_URL = "https://github.com/me/repo/issues/42";
const FOUND_JSON = JSON.stringify([
  { number: 42, title: "exact title", url: ISSUE_URL },
]);

function ghOk(stdout: string): ReturnType<GhRunner> {
  return { stdout, stderr: "", exitCode: 0 };
}

function ghErr(stderr: string, exitCode = 1): ReturnType<GhRunner> {
  return { stdout: "", stderr, exitCode };
}

describe(parseArgs, () => {
  it("parses required flags", () => {
    const out = parseArgs(["--title", "t", "--body-file", "/tmp/b.md"]);
    expect(out).toEqual({
      title: "t",
      bodyFile: "/tmp/b.md",
      labels: [],
      dryRun: false,
    });
  });

  it("parses comma-separated labels", () => {
    const out = parseArgs([
      "--title",
      "t",
      "--body-file",
      "b",
      "--label",
      "a,b,c",
    ]);
    expect(out).toEqual({
      title: "t",
      bodyFile: "b",
      labels: ["a", "b", "c"],
      dryRun: false,
    });
  });

  it("trims whitespace and drops empty labels", () => {
    const out = parseArgs([
      "--title",
      "t",
      "--body-file",
      "b",
      "--label",
      " a , , b ",
    ]);
    expect(out).toEqual({
      title: "t",
      bodyFile: "b",
      labels: ["a", "b"],
      dryRun: false,
    });
  });

  it("accepts --dry-run", () => {
    const out = parseArgs(["--title", "t", "--body-file", "b", "--dry-run"]);
    expect(out).toEqual({
      title: "t",
      bodyFile: "b",
      labels: [],
      dryRun: true,
    });
  });

  it("rejects --repo loudly (current-repo only in v1)", () => {
    const out = parseArgs([
      "--title",
      "t",
      "--body-file",
      "b",
      "--repo",
      "owner/other",
    ]);
    expect(out).toEqual({ error: "unknown flag: --repo" });
  });

  it("rejects unknown flags", () => {
    const out = parseArgs([
      "--title",
      "t",
      "--body-file",
      "b",
      "--milestone",
      "v1",
    ]);
    expect(out).toEqual({ error: "unknown flag: --milestone" });
  });

  it("requires --title", () => {
    expect(parseArgs(["--body-file", "b"])).toEqual({
      error: "--title is required",
    });
  });

  it("requires --body-file", () => {
    expect(parseArgs(["--title", "t"])).toEqual({
      error: "--body-file is required",
    });
  });

  it("rejects flag without a value", () => {
    expect(parseArgs(["--title"])).toEqual({
      error: "--title requires a value",
    });
    expect(parseArgs(["--title", "--body-file", "b"])).toEqual({
      error: "--title requires a value",
    });
  });
});

describe(probeExistingIssue, () => {
  it("returns found when an exact-title open issue exists", () => {
    const gh = vi.fn().mockReturnValue(ghOk(FOUND_JSON));
    const r = probeExistingIssue("exact title", gh);
    expect(r).toEqual({ kind: "found", number: 42, url: ISSUE_URL });
  });

  it("returns none when search is empty", () => {
    const gh = vi.fn().mockReturnValue(ghOk("[]"));
    expect(probeExistingIssue("anything", gh)).toEqual({ kind: "none" });
  });

  it("post-filters substring matches that aren't exact", () => {
    // GitHub's in:title is substring; "foo" matches "foo bar".
    // Without the post-filter the helper would spuriously dedupe.
    const stdout = JSON.stringify([
      { number: 7, title: "foo bar", url: "https://github.com/me/r/issues/7" },
      { number: 8, title: "the foo", url: "https://github.com/me/r/issues/8" },
    ]);
    const gh = vi.fn().mockReturnValue(ghOk(stdout));
    expect(probeExistingIssue("foo", gh)).toEqual({ kind: "none" });
  });

  it("returns error on non-zero gh exit", () => {
    const gh = vi.fn().mockReturnValue(ghErr("rate limited", 1));
    const r = probeExistingIssue("t", gh);
    expect(r).toMatchObject({ kind: "error" });
  });

  it("returns error on non-JSON gh stdout", () => {
    const gh = vi.fn().mockReturnValue(ghOk("not json"));
    const r = probeExistingIssue("t", gh);
    expect(r).toMatchObject({ kind: "error" });
  });
});

describe(ensureLabels, () => {
  it("runs gh label create --force once per label and returns ok", () => {
    const gh = vi.fn().mockReturnValue(ghOk(""));
    const r = ensureLabels(["flow-agent", "deferred-review"], gh);
    expect(r).toEqual({ kind: "ok" });
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls[0][0]).toEqual([
      "label",
      "create",
      "flow-agent",
      "--force",
    ]);
    expect(gh.mock.calls[1][0]).toEqual([
      "label",
      "create",
      "deferred-review",
      "--force",
    ]);
  });

  it("returns ok without calling gh when the label list is empty", () => {
    const gh = vi.fn();
    expect(ensureLabels([], gh)).toEqual({ kind: "ok" });
    expect(gh).not.toHaveBeenCalled();
  });

  it("returns error and stops at the first label that fails", () => {
    const gh = vi
      .fn()
      .mockReturnValueOnce(ghOk(""))
      .mockReturnValueOnce(ghErr("HTTP 403: must have admin rights", 1));
    const r = ensureLabels(
      ["flow-agent", "deferred-review", "out-of-scope-discovery"],
      gh,
    );
    expect(r).toMatchObject({ kind: "error" });
    // stops at the failing label — the third is never attempted
    expect(gh).toHaveBeenCalledTimes(2);
  });
});

describe(run, () => {
  it("prints would-create JSON on --dry-run without calling gh", () => {
    const gh = vi.fn();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = run(
      ["--title", "t", "--body-file", "/dev/null", "--dry-run"],
      { gh },
    );
    expect(code).toBe(0);
    expect(gh).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    const written = String(stdout.mock.calls[0][0]);
    expect(JSON.parse(written)).toEqual({
      action: "would-create",
      url: "",
      number: 0,
      title: "t",
    });
    stdout.mockRestore();
  });

  it("prints existing JSON when probe finds an exact-title issue", () => {
    const gh = vi.fn().mockReturnValueOnce(ghOk(FOUND_JSON));
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = run(["--title", "exact title", "--body-file", "/dev/null"], {
      gh,
    });
    expect(code).toBe(0);
    expect(gh).toHaveBeenCalledOnce();
    const written = String(stdout.mock.calls[0][0]);
    expect(JSON.parse(written)).toEqual({
      action: "existing",
      url: ISSUE_URL,
      number: 42,
      title: "exact title",
    });
    stdout.mockRestore();
  });

  it("provisions labels then calls gh issue create when probe is empty", () => {
    const gh = vi
      .fn()
      // probe → none
      .mockReturnValueOnce(ghOk("[]"))
      // gh label create flow-agent --force
      .mockReturnValueOnce(ghOk(""))
      // gh label create deferred-review --force
      .mockReturnValueOnce(ghOk(""))
      // create → URL on stdout
      .mockReturnValueOnce(ghOk("https://github.com/me/repo/issues/100\n"));
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = run(
      [
        "--title",
        "new",
        "--body-file",
        "/dev/null",
        "--label",
        "flow-agent,deferred-review",
      ],
      { gh },
    );
    expect(code).toBe(0);
    expect(gh).toHaveBeenCalledTimes(4);
    // every label is ensured before the issue is created
    expect(gh.mock.calls[1][0]).toEqual([
      "label",
      "create",
      "flow-agent",
      "--force",
    ]);
    expect(gh.mock.calls[2][0]).toEqual([
      "label",
      "create",
      "deferred-review",
      "--force",
    ]);
    expect(gh.mock.calls[3][0]).toEqual([
      "issue",
      "create",
      "--title",
      "new",
      "--body-file",
      "/dev/null",
      "--label",
      "flow-agent",
      "--label",
      "deferred-review",
    ]);
    const written = String(stdout.mock.calls[0][0]);
    expect(JSON.parse(written)).toEqual({
      action: "created",
      url: "https://github.com/me/repo/issues/100",
      number: 100,
      title: "new",
    });
    stdout.mockRestore();
  });

  it("does not provision labels on --dry-run", () => {
    const gh = vi.fn();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = run(
      [
        "--title",
        "t",
        "--body-file",
        "/dev/null",
        "--label",
        "flow-agent",
        "--dry-run",
      ],
      { gh },
    );
    expect(code).toBe(0);
    expect(gh).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it("does not provision labels when the probe finds an existing issue", () => {
    const gh = vi.fn().mockReturnValueOnce(ghOk(FOUND_JSON));
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = run(
      [
        "--title",
        "exact title",
        "--body-file",
        "/dev/null",
        "--label",
        "flow-agent",
      ],
      { gh },
    );
    expect(code).toBe(0);
    // only the probe ran — no gh label create, no gh issue create
    expect(gh).toHaveBeenCalledOnce();
    stdout.mockRestore();
  });

  it("aborts before gh issue create when label provisioning fails", () => {
    const gh = vi
      .fn()
      .mockReturnValueOnce(ghOk("[]"))
      .mockReturnValueOnce(ghErr("HTTP 403: must have admin rights", 1));
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const code = run(
      ["--title", "t", "--body-file", "/dev/null", "--label", "flow-agent"],
      {
        gh,
      },
    );
    expect(code).toBe(1);
    // probe + the failing label create — gh issue create is never reached
    expect(gh).toHaveBeenCalledTimes(2);
    expect(
      gh.mock.calls.some((c) => c[0][0] === "issue" && c[0][1] === "create"),
    ).toBe(false);
    errors.mockRestore();
  });

  it("does not call gh label create when no --label is passed", () => {
    const gh = vi
      .fn()
      .mockReturnValueOnce(ghOk("[]"))
      .mockReturnValueOnce(ghOk("https://github.com/me/repo/issues/7\n"));
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = run(["--title", "t", "--body-file", "/dev/null"], { gh });
    expect(code).toBe(0);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls.some((c) => c[0][0] === "label")).toBe(false);
    stdout.mockRestore();
  });

  it("returns 2 with usage on parse errors", () => {
    const gh = vi.fn();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const code = run(["--repo", "owner/repo"], { gh });
    expect(code).toBe(2);
    expect(gh).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    stderr.mockRestore();
    errors.mockRestore();
  });

  it("returns 1 when gh issue create exits non-zero", () => {
    const gh = vi
      .fn()
      .mockReturnValueOnce(ghOk("[]"))
      .mockReturnValueOnce(ghErr("rate limited", 1));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = run(["--title", "t", "--body-file", "/dev/null"], { gh });
    expect(code).toBe(1);
    stderr.mockRestore();
  });

  it("returns 1 when gh is not installed (exitCode -1)", () => {
    const gh = vi
      .fn()
      .mockReturnValue({ stdout: "", stderr: "", exitCode: -1 });
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const code = run(["--title", "t", "--body-file", "/dev/null"], { gh });
    expect(code).toBe(1);
    errors.mockRestore();
  });
});
