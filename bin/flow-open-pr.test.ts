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
  it("requires a slug as the first positional argument", () => {
    const r = parseArgs([]) as { error: string };
    expect(r.error).toMatch(/slug is required/);
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

  it("returns an error when gh exits non-zero", () => {
    const gh = vi.fn(() => ({ stdout: "", stderr: "no PR", exitCode: 1 }));
    const r = readCurrentPr(gh) as { error: string };
    expect(r.error).toMatch(/no PR/);
  });

  it("returns an error on non-JSON stdout", () => {
    const gh = vi.fn(() => ({ stdout: "not-json", stderr: "", exitCode: 0 }));
    const r = readCurrentPr(gh) as { error: string };
    expect(r.error).toMatch(/non-JSON/);
  });
});

describe("flow-open-pr run()", () => {
  it("creates a PR, reads the number, and writes it to state.json", () => {
    seedState("alpha");
    const { updater } = makeUpdater();
    const calls: string[][] = [];
    const gh = vi.fn((argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "pr" && argv[1] === "create") {
        return {
          stdout: "https://github.com/x/y/pull/142\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: JSON.stringify({ number: 142, url: "https://github.com/x/y/pull/142" }),
        stderr: "",
        exitCode: 0,
      };
    });

    const exit = run(["alpha", "--body-file", bodyFile, "--title", "feat: x"], { gh, updater });
    expect(exit).toBe(0);
    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--body-file",
      bodyFile,
      "--title",
      "feat: x",
    ]);
    expect(readState("alpha").pr).toBe(142);
  });

  it("falls through to gh pr view when gh pr create says 'already exists' (resume case)", () => {
    seedState("beta");
    const { updater } = makeUpdater();
    const gh = vi.fn((argv: string[]) => {
      if (argv[0] === "pr" && argv[1] === "create") {
        return {
          stdout: "",
          stderr:
            "a pull request for branch \"beta\" into branch \"main\" already exists:\n  https://github.com/x/y/pull/77\n",
          exitCode: 1,
        };
      }
      return {
        stdout: JSON.stringify({ number: 77, url: "https://github.com/x/y/pull/77" }),
        stderr: "",
        exitCode: 0,
      };
    });

    const exit = run(["beta", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(0);
    expect(readState("beta").pr).toBe(77);
  });

  it("propagates a real gh pr create failure (auth error etc.)", () => {
    seedState("gamma");
    const { updater } = makeUpdater();
    const gh = vi.fn((argv: string[]) => {
      if (argv[0] === "pr" && argv[1] === "create") {
        return { stdout: "", stderr: "gh: authentication required\n", exitCode: 4 };
      }
      throw new Error("should not reach pr view");
    });

    const exit = run(["gamma", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(4);
    expect(readState("gamma").pr).toBeUndefined();
  });

  it("returns 2 with usage when --body-file is missing", () => {
    const exit = run(["delta"], { gh: vi.fn(), updater: vi.fn() });
    expect(exit).toBe(2);
  });

  it("forwards --draft and --base to gh pr create", () => {
    seedState("epsilon");
    const { updater } = makeUpdater();
    const calls: string[][] = [];
    const gh = vi.fn((argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "pr" && argv[1] === "create") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: JSON.stringify({ number: 5, url: "https://github.com/x/y/pull/5" }),
        stderr: "",
        exitCode: 0,
      };
    });
    run(["epsilon", "--body-file", bodyFile, "--draft", "--base", "develop"], { gh, updater });
    expect(calls[0]).toContain("--draft");
    const baseIdx = calls[0].indexOf("--base");
    expect(calls[0][baseIdx + 1]).toBe("develop");
  });

  it("returns the updater's exit code when state-write fails (e.g. missing state file)", () => {
    // No seedState — the updater will exit 1.
    const { updater } = makeUpdater();
    const gh = vi.fn((argv: string[]) => {
      if (argv[0] === "pr" && argv[1] === "create") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: JSON.stringify({ number: 5, url: "https://github.com/x/y/pull/5" }),
        stderr: "",
        exitCode: 0,
      };
    });
    const exit = run(["zeta", "--body-file", bodyFile], { gh, updater });
    expect(exit).toBe(1);
  });
});
