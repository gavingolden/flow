import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, readCurrentPr, run } from "./flow-open-pr";
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
  return JSON.parse(fs.readFileSync(path.join(stateDir, `${slug}.json`), "utf8"));
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
    const r = parseArgs(["my-slug", "--body-file", "/tmp/x.md", "--bogus"]) as { error: string };
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
      stdout: JSON.stringify({ number: 99, url: "https://github.com/x/y/pull/99" }),
      stderr: "",
      exitCode: 0,
    }));
    const r = readCurrentPr(gh);
    expect(r).toEqual({ number: 99, url: "https://github.com/x/y/pull/99" });
  });

  it("returns an error when gh fails for a non-absent reason", () => {
    const gh = vi.fn(() => ({ stdout: "", stderr: "gh: authentication required", exitCode: 4 }));
    const r = readCurrentPr(gh) as { error: string };
    expect(r.error).toMatch(/authentication required/);
  });

  it("returns 'no PR exists' when gh reports the absence (no PR for current branch)", () => {
    const gh = vi.fn(() => ({
      stdout: "",
      stderr: "no pull requests found for branch \"feature\"",
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
  function makeGhSequence(steps: Array<{ matches: (argv: string[]) => boolean; response: GhResponse }>) {
    const calls: string[][] = [];
    let cursor = 0;
    const gh = vi.fn((argv: string[]) => {
      calls.push(argv);
      const step = steps[cursor];
      if (!step) throw new Error(`unexpected gh call (no step left): ${argv.join(" ")}`);
      if (!step.matches(argv)) {
        throw new Error(`gh call ${cursor} did not match: got ${argv.join(" ")}`);
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

  it("creates a PR, reads the number, and writes it to state.json (fresh-create path)", () => {
    seedState("alpha");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({ number: 142, url: "https://github.com/x/y/pull/142" }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "https://github.com/x/y/pull/142\n", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);

    const exit = run(["alpha", "--body-file", bodyFile, "--title", "feat: x"], { gh, updater });
    expect(exit).toBe(0);
    expect(calls[1]).toEqual(["pr", "create", "--body-file", bodyFile, "--title", "feat: x"]);
    expect(readState("alpha").pr).toBe(142);
  });

  it("skips gh pr create when the branch already has a PR (resume case, no stderr parsing)", () => {
    seedState("beta");
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({ number: 77, url: "https://github.com/x/y/pull/77" }),
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
      { matches: isCreate, response: { stdout: "", stderr: "gh: authentication required\n", exitCode: 4 } },
    ]);

    const exit = run(["gamma", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(4);
    expect(readState("gamma").pr).toBeUndefined();
  });

  it("returns 1 when the initial pr view fails for a non-absent reason", () => {
    seedState("eta");
    const { updater } = makeUpdater();
    const { gh } = makeGhSequence([
      { matches: isView, response: { stdout: "", stderr: "gh: authentication required", exitCode: 4 } },
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
      stdout: JSON.stringify({ number: 5, url: "https://github.com/x/y/pull/5" }),
      stderr: "",
      exitCode: 0,
    };
    const { gh, calls } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    run(["epsilon", "--body-file", bodyFile, "--draft", "--base", "develop"], { gh, updater });
    const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(createCall).toContain("--draft");
    const baseIdx = createCall.indexOf("--base");
    expect(createCall[baseIdx + 1]).toBe("develop");
  });

  it("returns the updater's exit code when state-write fails (e.g. missing state file)", () => {
    // No seedState — the updater will exit 1.
    const { updater } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({ number: 5, url: "https://github.com/x/y/pull/5" }),
      stderr: "",
      exitCode: 0,
    };
    const { gh } = makeGhSequence([
      { matches: isView, response: NO_PR },
      { matches: isCreate, response: { stdout: "", stderr: "", exitCode: 0 } },
      { matches: isView, response: prJson },
    ]);
    const exit = run(["zeta", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(1);
  });

  it("auto-resolves the slug from $TMUX_PANE when omitted", () => {
    seedState("theta");
    const { updater, calls: updaterCalls } = makeUpdater();
    const prJson: GhResponse = {
      stdout: JSON.stringify({ number: 8, url: "https://github.com/x/y/pull/8" }),
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
      stdout: JSON.stringify({ number: 9, url: "https://github.com/x/y/pull/9" }),
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
      resolveSlug: () => "other-pipeline",
    });
    expect(exit).toBe(0);
    expect(updaterCalls[0]?.[0]).toBe("iota");
    expect(readState("iota").pr).toBe(9);
  });
});

type GhResponse = { stdout: string; stderr: string; exitCode: number };
