import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  probeCheckpoint,
  run,
  type CheckpointResult,
} from "./flow-checkpoint";
import { writeState, type PipelineState } from "./lib/state";

let stateDir!: string;
let worktreeRoot!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-checkpoint-state-"));
  worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-checkpoint-wt-"));
  fs.mkdirSync(path.join(worktreeRoot, ".flow-tmp"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
});

function seedState(slug: string, overrides: Partial<PipelineState> = {}): void {
  writeState(
    {
      slug,
      phase: "checkpoint-pending-clear",
      repo: "/tmp/repo",
      worktree: worktreeRoot,
      updatedAt: "2026-06-30T12:00:00Z",
      ...overrides,
    },
    stateDir,
  );
}

function writeCheckpoint(body = "approved with condition X\n"): void {
  fs.writeFileSync(path.join(worktreeRoot, ".flow-tmp", "checkpoint.md"), body);
}

function markerFile(): string {
  return path.join(worktreeRoot, ".flow-tmp", "checkpoint.pending");
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

function runCapture(
  argv: string[],
  slug?: string,
): CheckpointResult & { exit: number } {
  const { writes, restore } = captureStdout();
  const exit = run(argv, {
    stateDir,
    resolveSlug: () => slug ?? null,
  });
  restore();
  const result = JSON.parse(writes.join("")) as CheckpointResult;
  return { ...result, exit };
}

describe("probeCheckpoint", () => {
  it("is false when checkpoint.md is missing", () => {
    expect(probeCheckpoint(worktreeRoot)).toBe(false);
  });

  it("is false when checkpoint.md is empty", () => {
    fs.writeFileSync(path.join(worktreeRoot, ".flow-tmp", "checkpoint.md"), "");
    expect(probeCheckpoint(worktreeRoot)).toBe(false);
  });

  it("is true when checkpoint.md is present and non-empty", () => {
    writeCheckpoint();
    expect(probeCheckpoint(worktreeRoot)).toBe(true);
  });
});

describe("parseArgs", () => {
  it("treats empty argv as slug-omitted, consume off", () => {
    expect(parseArgs([])).toEqual({ slug: undefined, consume: false });
  });

  it("accepts a positional slug", () => {
    expect(parseArgs(["my-slug"])).toEqual({ slug: "my-slug", consume: false });
  });

  it("accepts --consume in either order", () => {
    expect(parseArgs(["--consume"])).toEqual({
      slug: undefined,
      consume: true,
    });
    expect(parseArgs(["my-slug", "--consume"])).toEqual({
      slug: "my-slug",
      consume: true,
    });
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });
});

describe("run() — ready / needs", () => {
  it("ready verdict (exit 0) + writes the .pending marker when checkpoint.md + state.json are present", () => {
    seedState("alpha");
    writeCheckpoint();
    const r = runCapture(["alpha"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(r.worktree).toBe(worktreeRoot);
    expect(r.marker).toBe(markerFile());
    expect(fs.existsSync(markerFile())).toBe(true);
  });

  it("needs verdict + writes NO marker when checkpoint.md is missing", () => {
    seedState("beta");
    const r = runCapture(["beta"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("needs");
    expect(r.reason).toBe("checkpoint-missing");
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it("needs verdict (state-missing) when the state file is absent", () => {
    const r = runCapture(["ghost"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("needs");
    expect(r.reason).toBe("state-missing");
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it("auto-resolves the slug from the pane resolver when omitted", () => {
    seedState("gamma");
    writeCheckpoint();
    const r = runCapture([], "gamma");
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(r.slug).toBe("gamma");
  });
});

describe("run() — --consume", () => {
  it("removes an existing .pending marker and reports consumed", () => {
    seedState("delta");
    fs.writeFileSync(markerFile(), "delta\n");
    const r = runCapture(["delta", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("consumed");
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it("is a no-op when no marker is present", () => {
    seedState("epsilon");
    const r = runCapture(["epsilon", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("no-marker");
  });
});

describe("run() — CLI errors", () => {
  it("exits 2 when no slug resolves", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run([], { stateDir, resolveSlug: () => null });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("exits 2 on an unknown flag", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = run(["--bogus"], { stateDir, resolveSlug: () => "x" });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
