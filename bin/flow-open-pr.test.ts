import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isValidSessionId,
  parseArgs,
  readCurrentPr,
  run,
} from "./flow-open-pr";
import { runUpdate } from "./flow-state-update";

let scratch!: string;
let stateDir!: string;
let bodyFile!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-open-pr-"));
  stateDir = path.join(scratch, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  bodyFile = path.join(scratch, "body.md");
  fs.writeFileSync(bodyFile, "## Why\n\nbecause.\n");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function seedState(slug: string): void {
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify({
      slug,
      phase: "implementing",
      repo: scratch,
      updatedAt: new Date().toISOString(),
    }) + "\n",
  );
}

function readState(slug: string) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDir, `${slug}.json`), "utf8"),
  );
}

/** A test updater that delegates to the real runUpdate but against the test stateDir. */
function makeUpdater() {
  const calls: string[][] = [];
  const updater = (argv: string[]) => {
    calls.push(argv);
    return runUpdate(argv, stateDir);
  };
  return { updater, calls };
}

describe(parseArgs, () => {
  it("requires --body-file when no args are given", () => {
    const r = parseArgs([]) as { error: string };
    expect(r.error).toMatch(/--body-file is required/);
  });

  it("treats a leading flag as 'slug omitted' (auto-resolve path)", () => {
    // Previously rejected with 'slug must be the first positional argument'.
    // The supervisor now relies on this form: the slug auto-resolves from
    // $TMUX_PANE.
    const r = parseArgs(["--body-file", "/tmp/x.md"]);
    expect(r).toEqual({ bodyFile: "/tmp/x.md", draft: false });
  });

  it("requires --body-file", () => {
    const r = parseArgs(["my-slug"]) as { error: string };
    expect(r.error).toMatch(/--body-file is required/);
  });

  it("rejects an unknown flag", () => {
    const r = parseArgs(["my-slug", "--body-file", "/tmp/x.md", "--bogus"]) as {
      error: string;
    };
    expect(r.error).toMatch(/unknown flag/);
  });

  it("parses --title, --draft, --base", () => {
    const r = parseArgs([
      "my-slug",
      "--body-file",
      "/tmp/x.md",
      "--title",
      "feat: x",
      "--draft",
      "--base",
      "develop",
    ]);
    expect(r).toEqual({
      slug: "my-slug",
      bodyFile: "/tmp/x.md",
      title: "feat: x",
      draft: true,
      base: "develop",
    });
  });

  it("rejects --title without a value", () => {
    const r = parseArgs(["my-slug", "--body-file", "/tmp/x.md", "--title"]) as {
      error: string;
    };
    expect(r.error).toMatch(/--title requires a value/);
  });
});

describe(readCurrentPr, () => {
  it("returns parsed PR info on success", () => {
    const gh = vi.fn(() => ({
      stdout: JSON.stringify({
        number: 99,
        url: "https://github.com/x/y/pull/99",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const r = readCurrentPr(gh);
    expect(r).toEqual({ number: 99, url: "https://github.com/x/y/pull/99" });
  });

  it("returns an error when gh fails for a non-absent reason", () => {
    const gh = vi.fn(() => ({
      stdout: "",
      stderr: "gh: authentication required",
      exitCode: 4,
    }));
    const r = readCurrentPr(gh) as { error: string };
    expect(r.error).toMatch(/authentication required/);
  });

  it("returns 'no PR exists' when gh reports the absence (no PR for current branch)", () => {
    const gh = vi.fn(() => ({
      stdout: "",
      stderr: 'no pull requests found for branch "feature"',
      exitCode: 1,
    }));
    const r = readCurrentPr(gh) as { error: string };
    expect(r.error).toMatch(/no PR exists/);
  });

  it("returns an error on non-JSON stdout", () => {
    const gh = vi.fn(() => ({ stdout: "not-json", stderr: "", exitCode: 0 }));
    const r = readCurrentPr(gh) as { error: string };
    expect(r.error).toMatch(/non-JSON/);
  });
});

describe("flow-open-pr run()", () => {
  /**
   * Builds a gh mock that replays a queue of {match, response} pairs in order.
   * Each call consumes the first matching entry. This is more robust than
   * branching on argv shape inline because the new probe-first design calls
   * `pr view` twice on the fresh-create path (probe, then re-probe), and
   * inline branching gave the same response to both.
   */
  function makeGhSequence(
    steps: Array<{
      matches: (argv: string[]) => boolean;
      response: GhResponse;
    }>,
  ) {
    const calls: string[][] = [];
    let cursor = 0;
    const gh = vi.fn((argv: string[]) => {
      calls.push(argv);
      const step = steps[cursor];
      if (!step)
        throw new Error(`unexpected gh call (no step left): ${argv.join(" ")}`);
      if (!step.matches(argv)) {
        throw new Error(
          `gh call ${cursor} did not match: got ${argv.join(" ")}`,
        );
      }
      cursor++;
      return step.response;
    });
    return { gh, calls };
  }

  const NO_PR: GhResponse = {
    stdout: "",
    stderr: "no pull requests found for the current branch",
    exitCode: 1,
  };

  const isView = (argv: string[]) => argv[0] === "pr" && argv[1] === "view";
  const isCreate = (argv: string[]) => argv[0] === "pr" && argv[1] === "create";

  const isBranchName = (argv: string[]) =>
    argv[0] === "rev-parse" && argv[argv.length - 1] === "HEAD";
  const isLsRemote = (argv: string[]) =>
    argv[0] === "ls-remote" && argv.includes("--heads");
  const isPush = (argv: string[]) => argv[0] === "push" && argv[1] === "-u";

  /**
   * Mirrors `makeGhSequence` for the injected git seam: replays a queue of
   * {match, response} pairs in order. The fresh-create path now resolves the
   * branch name (`rev-parse --abbrev-ref HEAD`), probes whether that branch's
   * head exists on origin (`ls-remote --exit-code --heads origin <branch>`),
   * and pushes only when it is absent — all before `gh pr create`. So every
   * probe-`none` case must inject a git mock or the real `defaultGit` would
   * shell out in the non-repo scratch dir.
   */
  function makeGitSequence(
    steps: Array<{
      matches: (argv: string[]) => boolean;
      response: GhResponse;
    }>,
  ) {
    const calls: string[][] = [];
    let cursor = 0;
    const git = vi.fn((argv: string[]) => {
      calls.push(argv);
      const step = steps[cursor];
      if (!step)
        throw new Error(
          `unexpected git call (no step left): ${argv.join(" ")}`,
        );
      if (!step.matches(argv)) {
        throw new Error(
          `git call ${cursor} did not match: got ${argv.join(" ")}`,
        );
      }
      cursor++;
      return step.response;
    });
    return { git, calls };
  }

  /**
   * The default git seam for every pre-existing fresh-create case: resolves a
   * branch name (`rev-parse` exit 0) and reports that branch's head already
   * exists on origin (`ls-remote` exit 0) so `run()` skips the pre-create
   * push. Returns just the mock — these cases don't assert on git calls.
   */
  function branchOnRemoteGit() {
    return vi.fn((argv: string[]) => {
      if (argv[0] === "rev-parse")
        return { stdout: "feature\n", stderr: "", exitCode: 0 };
      // ls-remote --exit-code: exit 0 ⇒ the branch's head exists on origin.
      return {
        stdout: "abc123\trefs/heads/feature\n",
        stderr: "",
        exitCode: 0,
      };
    });
  }

  it("creates a PR, reads the number, and writes it to state.json (fresh-create path)", () => {
    seedState("alpha");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 142,
        url: "https://github.com/x/y/pull/142",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      {
        matches: isCreate,
        response: {
          stdout: "https://github.com/x/y/pull/142\n",
          stderr: "",
          exitCode: 0,
        },
      },
      { matches: isView, response: prJson },
    ]);

    // sessionId: "" pins the no-marker path so the assertion holds
    // regardless of an ambient CLAUDE_CODE_SESSION_ID in the harness env.
    const exit = run(["alpha", "--body-file", bodyFile, "--title", "feat: x"], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      sessionId: "",
    });
    expect(exit).toBe(0);
    expect(calls[1]).toEqual([
      "pr",
      "create",
      "--body-file",
      bodyFile,
      "--title",
      "feat: x",
    ]);
    expect(readState("alpha").pr).toBe(142);
  });

  it("skips gh pr create when the branch already has a PR (resume case, no stderr parsing)", () => {
    seedState("beta");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 77,
        url: "https://github.com/x/y/pull/77",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      // Probe-first: pr view returns the existing PR; pr create is never invoked.
      { matches: isView, response: prJson },
    ]);

    const exit = run(["beta", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(0);
    expect(readState("beta").pr).toBe(77);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(false);
  });

  it("propagates a real gh pr create failure (auth error etc.)", () => {
    seedState("gamma");
    const { updater } = makeUpdater();
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      {
        matches: isCreate,
        response: {
          stdout: "",
          stderr: "gh: authentication required\n",
          exitCode: 4,
        },
      },
    ]);

    const exit = run(["gamma", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
    });
    expect(exit).toBe(4);
    expect(readState("gamma").pr).toBeUndefined();
  });

  it("returns 1 when the initial pr view fails for a non-absent reason", () => {
    seedState("eta");
    const { updater } = makeUpdater();
    const { gh } = makeGhSequence([
      {
        matches: isView,
        response: {
          stdout: "",
          stderr: "gh: authentication required",
          exitCode: 4,
        },
      },
    ]);

    const exit = run(["eta", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(1);
    expect(readState("eta").pr).toBeUndefined();
  });

  it("returns 2 with usage when --body-file is missing", () => {
    const exit = run(["delta"], { gh: vi.fn(), updater: vi.fn() });
    expect(exit).toBe(2);
  });

  it("forwards --draft and --base to gh pr create", () => {
    seedState("epsilon");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 5,
        url: "https://github.com/x/y/pull/5",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    run(["epsilon", "--body-file", bodyFile, "--draft", "--base", "develop"], {
      gh,
      updater,
      git: branchOnRemoteGit(),
    });
    const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(createCall).toContain("--draft");
    const baseIdx = createCall.indexOf("--base");
    expect(createCall[baseIdx + 1]).toBe("develop");
  });

  it("returns the updater's exit code when state-write fails (e.g. missing state file)", () => {
    // No seedState — the updater will exit 1.
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 5,
        url: "https://github.com/x/y/pull/5",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    const exit = run(["zeta", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
    });
    expect(exit).toBe(1);
  });

  it("auto-resolves the slug from $TMUX_PANE when omitted", () => {
    seedState("theta");
    const { updater, calls: updaterCalls } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 8,
        url: "https://github.com/x/y/pull/8",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    const exit = run(["--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      resolveSlug: () => "theta",
    });
    expect(exit).toBe(0);
    expect(readState("theta").pr).toBe(8);
    expect(updaterCalls[0]?.[0]).toBe("theta");
  });

  it("returns 2 with a clear error when no slug given and pane has none either", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--body-file", bodyFile], {
      gh: vi.fn(),
      updater: vi.fn(),
      resolveSlug: () => null,
    });
    expect(exit).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("@flow-slug");
    errSpy.mockRestore();
  });

  it("prefers an explicit positional slug over the pane resolver (back-compat)", () => {
    seedState("iota");
    seedState("other-pipeline");
    const { updater, calls: updaterCalls } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 9,
        url: "https://github.com/x/y/pull/9",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    const exit = run(["iota", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      resolveSlug: () => "other-pipeline",
    });
    expect(exit).toBe(0);
    expect(updaterCalls[0]?.[0]).toBe("iota");
    expect(readState("iota").pr).toBe(9);
  });

  // --- session-ID marker + trailer carrier ---------------------------------

  const VALID_SESSION = "b034430c-03bd-4fa0-8393-9f0859800531";

  /** Reads the `--body-file` content from a recorded `gh pr create` call. */
  function createBodyContent(calls: string[][]): string {
    const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
    if (!createCall) throw new Error("no pr create call recorded");
    const idx = createCall.indexOf("--body-file");
    return fs.readFileSync(createCall[idx + 1], "utf8");
  }

  it("appends the self-describing marker on a fresh create when the session ID is valid", () => {
    seedState("marker-create");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 31,
        url: "https://github.com/x/y/pull/31",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    const exit = run(["marker-create", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      sessionId: VALID_SESSION,
    });
    expect(exit).toBe(0);
    const body = createBodyContent(calls);
    expect(body).toContain("## Why"); // original body preserved
    expect(body).toContain("Claude Code session");
    expect(body).toContain(VALID_SESSION);
    expect(body).toContain("<!-- flow:");
  });

  it("does not append a marker when the session ID is absent", () => {
    seedState("no-session");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 32,
        url: "https://github.com/x/y/pull/32",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // sessionId: "" models the "no CLAUDE_CODE_SESSION_ID" case
    // deterministically — the empty string fails isValidSessionId.
    const exit = run(["no-session", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      sessionId: "",
    });
    expect(exit).toBe(0);
    // No marker injection ⇒ create still points at the original body file.
    const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(createCall[createCall.indexOf("--body-file") + 1]).toBe(bodyFile);
    expect(createBodyContent(calls)).not.toContain("Claude Code session");
  });

  it("does not append a marker when the session ID fails isValidSessionId", () => {
    seedState("bad-session");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 33,
        url: "https://github.com/x/y/pull/33",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // A value carrying a newline fails the guard.
    const exit = run(["bad-session", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      sessionId: "id-with\nnewline",
    });
    expect(exit).toBe(0);
    expect(createBodyContent(calls)).not.toContain("Claude Code session");
  });

  it("forwards --session-id to the updater on the fresh-create path", () => {
    seedState("forward-create");
    const { updater, calls: updaterCalls } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 34,
        url: "https://github.com/x/y/pull/34",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    const exit = run(["forward-create", "--body-file", bodyFile], {
      gh,
      updater,
      git: branchOnRemoteGit(),
      sessionId: VALID_SESSION,
    });
    expect(exit).toBe(0);
    expect(updaterCalls[0]).toEqual([
      "forward-create",
      "--pr",
      "34",
      "--session-id",
      VALID_SESSION,
    ]);
    expect(readState("forward-create").sessionId).toBe(VALID_SESSION);
  });

  it("forwards --session-id to the updater on the resume (found) path without re-appending the marker", () => {
    seedState("forward-resume");
    const { updater, calls: updaterCalls } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 35,
        url: "https://github.com/x/y/pull/35",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      // Probe-first finds an existing PR — resume path, no create call.
      { matches: isView, response: prJson },
    ]);
    const exit = run(["forward-resume", "--body-file", bodyFile], {
      gh,
      updater,
      sessionId: VALID_SESSION,
    });
    expect(exit).toBe(0);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(false);
    expect(updaterCalls[0]).toEqual([
      "forward-resume",
      "--pr",
      "35",
      "--session-id",
      VALID_SESSION,
    ]);
    // The marker is appended only on fresh create — the body file is untouched.
    expect(fs.readFileSync(bodyFile, "utf8")).not.toContain(
      "Claude Code session",
    );
  });

  // --- pre-create auto-push when the branch's head is absent on origin ------

  it("pushes the branch before gh pr create when its head is absent on origin", () => {
    seedState("nopush");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 50,
        url: "https://github.com/x/y/pull/50",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls: ghCalls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // rev-parse HEAD → branch name (exit 0); ls-remote --exit-code → exit 2
    // (branch absent on origin) → push fires; push exit 0 → create proceeds.
    const { git, calls: gitCalls } = makeGitSequence([
      {
        matches: isBranchName,
        response: { stdout: "feature\n", stderr: "", exitCode: 0 },
      },
      {
        matches: isLsRemote,
        response: { stdout: "", stderr: "", exitCode: 2 },
      },
      { matches: isPush, response: { stdout: "", stderr: "", exitCode: 0 } },
    ]);
    const exit = run(["nopush", "--body-file", bodyFile], {
      gh,
      updater,
      git,
      sessionId: "",
    });
    expect(exit).toBe(0);
    // The push fired with the expected argv ...
    expect(gitCalls).toContainEqual(["push", "-u", "origin", "HEAD"]);
    // ... and gh pr create still ran after the push.
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(true);
    expect(readState("nopush").pr).toBe(50);
  });

  it("skips the push when the branch's head already exists on origin", () => {
    seedState("haspush");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 51,
        url: "https://github.com/x/y/pull/51",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // ls-remote exit 0 (branch present on origin) → no push call is consumed.
    const { git, calls: gitCalls } = makeGitSequence([
      {
        matches: isBranchName,
        response: { stdout: "feature\n", stderr: "", exitCode: 0 },
      },
      {
        matches: isLsRemote,
        response: {
          stdout: "abc123\trefs/heads/feature\n",
          stderr: "",
          exitCode: 0,
        },
      },
    ]);
    const exit = run(["haspush", "--body-file", bodyFile], {
      gh,
      updater,
      git,
      sessionId: "",
    });
    expect(exit).toBe(0);
    expect(gitCalls.some((c) => c[0] === "push")).toBe(false);
    expect(readState("haspush").pr).toBe(51);
  });

  it("propagates a push failure and never calls gh pr create", () => {
    seedState("pushfail");
    const { updater } = makeUpdater();
    // Only the initial probe is consumed — create is never reached.
    const { gh, calls: ghCalls } = makeGhSequence([
      { matches: isView, response: NO_PR },
    ]);
    const { git } = makeGitSequence([
      {
        matches: isBranchName,
        response: { stdout: "feature\n", stderr: "", exitCode: 0 },
      },
      {
        matches: isLsRemote,
        response: { stdout: "", stderr: "", exitCode: 2 },
      },
      {
        matches: isPush,
        response: { stdout: "", stderr: "remote rejected\n", exitCode: 128 },
      },
    ]);
    const exit = run(["pushfail", "--body-file", bodyFile], {
      gh,
      updater,
      git,
      sessionId: "",
    });
    expect(exit).toBe(128);
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(false);
    expect(readState("pushfail").pr).toBeUndefined();
  });

  it("skips the push (no ls-remote, no push) on a detached HEAD and still creates the PR", () => {
    seedState("detached");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 52,
        url: "https://github.com/x/y/pull/52",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls: ghCalls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // `rev-parse --abbrev-ref HEAD` reports a detached HEAD as the literal
    // "HEAD" (exit 0). The branchName !== "HEAD" guard must then skip the
    // ls-remote/push pair — only the rev-parse step is consumed.
    const { git, calls: gitCalls } = makeGitSequence([
      {
        matches: isBranchName,
        response: { stdout: "HEAD\n", stderr: "", exitCode: 0 },
      },
    ]);
    const exit = run(["detached", "--body-file", bodyFile], {
      gh,
      updater,
      git,
      sessionId: "",
    });
    expect(exit).toBe(0);
    // No remote-existence probe and no push on a detached HEAD ...
    expect(gitCalls.some((c) => c[0] === "ls-remote")).toBe(false);
    expect(gitCalls.some((c) => c[0] === "push")).toBe(false);
    // ... but gh pr create still runs and the PR number lands in state.
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(true);
    expect(readState("detached").pr).toBe(52);
  });

  it("skips the push when rev-parse exits non-zero and still creates the PR", () => {
    seedState("revparsefail");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 53,
        url: "https://github.com/x/y/pull/53",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls: ghCalls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // A non-zero rev-parse fails the `branchRef.exitCode === 0` clause, so the
    // ls-remote/push pair is skipped — only the rev-parse step is consumed.
    const { git, calls: gitCalls } = makeGitSequence([
      {
        matches: isBranchName,
        response: {
          stdout: "",
          stderr: "fatal: not a git repo\n",
          exitCode: 128,
        },
      },
    ]);
    const exit = run(["revparsefail", "--body-file", bodyFile], {
      gh,
      updater,
      git,
      sessionId: "",
    });
    expect(exit).toBe(0);
    expect(gitCalls.some((c) => c[0] === "ls-remote")).toBe(false);
    expect(gitCalls.some((c) => c[0] === "push")).toBe(false);
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(true);
    expect(readState("revparsefail").pr).toBe(53);
  });

  it("skips the push when rev-parse yields an empty branch name and still creates the PR", () => {
    seedState("emptybranch");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({
        number: 54,
        url: "https://github.com/x/y/pull/54",
      }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls: ghCalls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    // An empty branch name (exit 0, blank stdout) fails the `branchName` clause
    // of the guard, so the ls-remote/push pair is skipped — only rev-parse runs.
    const { git, calls: gitCalls } = makeGitSequence([
      {
        matches: isBranchName,
        response: { stdout: "\n", stderr: "", exitCode: 0 },
      },
    ]);
    const exit = run(["emptybranch", "--body-file", bodyFile], {
      gh,
      updater,
      git,
      sessionId: "",
    });
    expect(exit).toBe(0);
    expect(gitCalls.some((c) => c[0] === "ls-remote")).toBe(false);
    expect(gitCalls.some((c) => c[0] === "push")).toBe(false);
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(true);
    expect(readState("emptybranch").pr).toBe(54);
  });
});

describe("isValidSessionId", () => {
  const cases: Array<[label: string, input: string, expected: boolean]> = [
    ["valid UUID-shaped id", "b034430c-03bd-4fa0-8393-9f0859800531", true],
    ["leading/trailing whitespace but non-empty", "  abc123  ", true],
    ["empty string", "", false],
    ["whitespace-only", "   ", false],
    ["newline-bearing", "id-with\nnewline", false],
    ["carries an HTML comment closer `-->`", "uuid--> - [ ] injected", false],
    ["carries an HTML comment opener `<!--`", "uuid<!--x", false],
  ];

  for (const [label, input, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${label}`, () => {
      expect(isValidSessionId(input)).toBe(expected);
    });
  }
});

type GhResponse = { stdout: string; stderr: string; exitCode: number };
