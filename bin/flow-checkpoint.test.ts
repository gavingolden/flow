import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveCheckpoint,
  consumedPath,
  parseArgs,
  probeCheckpoint,
  run,
  type CheckpointResult,
} from "./flow-checkpoint";
import { readState, writeState, type PipelineState } from "./lib/state";

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
  it("treats empty argv as slug-omitted, consume off, probe off, site manual", () => {
    expect(parseArgs([])).toEqual({
      slug: undefined,
      consume: false,
      probe: false,
      site: "manual",
    });
  });

  it("accepts a positional slug", () => {
    expect(parseArgs(["my-slug"])).toEqual({
      slug: "my-slug",
      consume: false,
      probe: false,
      site: "manual",
    });
  });

  it("accepts --consume in either order", () => {
    expect(parseArgs(["--consume"])).toEqual({
      slug: undefined,
      consume: true,
      probe: false,
      site: "manual",
    });
    expect(parseArgs(["my-slug", "--consume"])).toEqual({
      slug: "my-slug",
      consume: true,
      probe: false,
      site: "manual",
    });
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("accepts --probe with an explicit --site", () => {
    expect(parseArgs(["my-slug", "--probe", "--site", "gate"])).toEqual({
      slug: "my-slug",
      consume: false,
      probe: true,
      site: "gate",
    });
  });

  it("rejects an unknown --site value", () => {
    expect(parseArgs(["--site", "bogus"])).toEqual({
      error: "unknown --site value: bogus",
    });
  });

  it("rejects --probe combined with --consume", () => {
    expect(parseArgs(["--probe", "--consume"])).toEqual({
      error: "--probe and --consume are mutually exclusive",
    });
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

describe("run() — --consume archives the body", () => {
  it("archives checkpoint.md, clears the freshness record, and a later --probe --site gate returns write (the reported scenario)", () => {
    seedState("zeta");
    writeCheckpoint("plan-approval body\n");
    runCapture(["zeta", "--site", "plan-approval"]); // arm
    const consumeResult = runCapture(["zeta", "--consume"]);
    expect(consumeResult.exit).toBe(0);
    expect(
      fs.existsSync(path.join(worktreeRoot, ".flow-tmp", "checkpoint.md")),
    ).toBe(false);
    expect(fs.existsSync(consumedPath(worktreeRoot))).toBe(true);
    expect(fs.readFileSync(consumedPath(worktreeRoot), "utf8")).toBe(
      "plan-approval body\n",
    );
    expect(readState("zeta", stateDir)?.checkpoint).toBeUndefined();

    const probeResult = runCapture(["zeta", "--probe", "--site", "gate"]);
    expect(probeResult.verdict).toBe("write");
  });

  it("is a no-op with no marker and no body, and a rename failure still exits 0 (degrades to unlink)", () => {
    seedState("eta");
    const r = runCapture(["eta", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("noop");
    expect(r.archived).toBeUndefined();

    // Force the rename inside archiveCheckpoint to fail by pre-occupying the
    // destination with a non-empty directory (ENOTEMPTY on rename).
    fs.mkdirSync(consumedPath(worktreeRoot));
    fs.writeFileSync(path.join(consumedPath(worktreeRoot), "keep"), "x");
    fs.writeFileSync(
      path.join(worktreeRoot, ".flow-tmp", "checkpoint.md"),
      "body\n",
    );
    const archived = archiveCheckpoint(worktreeRoot);
    expect(archived).toBeNull();
    expect(
      fs.existsSync(path.join(worktreeRoot, ".flow-tmp", "checkpoint.md")),
    ).toBe(false); // unlinked despite the failed rename
    fs.rmSync(consumedPath(worktreeRoot), { recursive: true, force: true });
  });
});

describe("probeFreshness / --probe", () => {
  function phaseLog(...entries: Array<{ phase: string; at: string }>) {
    return entries;
  }

  it("returns write (auto-refresh) when the never-cleared auto-site leaks past a later phase advance", () => {
    seedState("theta");
    writeCheckpoint("auto body\n");
    runCapture(["theta", "--site", "plan-approval"]); // arm, no consume
    writeState(
      {
        ...(readState("theta", stateDir) as PipelineState),
        phaseLog: phaseLog({
          phase: "implementing",
          at: "2099-01-01T00:00:00.000Z",
        }),
      },
      stateDir,
    );
    const r = runCapture(["theta", "--probe", "--site", "gate"]);
    expect(r.verdict).toBe("write");
    expect(r.reason).toContain("auto-refresh:plan-approval");
  });

  it("preserves a fresh manual note with no later phase advance", () => {
    seedState("iota");
    writeCheckpoint("manual note\n");
    runCapture(["iota", "--site", "manual"]);
    const r = runCapture(["iota", "--probe", "--site", "gate"]);
    expect(r.verdict).toBe("preserve");
    expect(r.reason).toBe("fresh-manual");
  });

  it("writes over a manual note once the phase has advanced since it was armed", () => {
    seedState("kappa");
    writeCheckpoint("manual note\n");
    runCapture(["kappa", "--site", "manual"]);
    writeState(
      {
        ...(readState("kappa", stateDir) as PipelineState),
        phaseLog: phaseLog({
          phase: "implementing",
          at: "2099-01-01T00:00:00.000Z",
        }),
      },
      stateDir,
    );
    const r = runCapture(["kappa", "--probe", "--site", "gate"]);
    expect(r.verdict).toBe("write");
    expect(r.reason).toContain("stale-manual:");
  });

  it("record-less body: mtime after the newest phaseLog entry preserves, before it writes", () => {
    seedState("lambda", {
      phaseLog: phaseLog({
        phase: "implementing",
        at: "2020-01-01T00:00:00.000Z",
      }),
    });
    writeCheckpoint("unrecorded body\n");
    const fresh = runCapture(["lambda", "--probe", "--site", "gate"]);
    expect(fresh.verdict).toBe("preserve");
    expect(fresh.reason).toBe("fresh-unrecorded");

    seedState("mu", {
      phaseLog: phaseLog({
        phase: "implementing",
        at: "2099-01-01T00:00:00.000Z",
      }),
    });
    fs.writeFileSync(
      path.join(worktreeRoot, ".flow-tmp", "checkpoint.md"),
      "unrecorded body\n",
    );
    const stale = runCapture(["mu", "--probe", "--site", "gate"]);
    expect(stale.verdict).toBe("write");
    expect(stale.reason).toBe("stale-unrecorded");
  });

  it("fails open to write on missing state, missing worktree, or absent checkpoint.md", () => {
    const missingState = runCapture([
      "ghost-probe",
      "--probe",
      "--site",
      "gate",
    ]);
    expect(missingState.exit).toBe(0);
    expect(missingState.verdict).toBe("write");

    seedState("nu", { worktree: undefined });
    const missingWorktree = runCapture(["nu", "--probe", "--site", "gate"]);
    expect(missingWorktree.verdict).toBe("write");

    seedState("xi");
    const absentBody = runCapture(["xi", "--probe", "--site", "gate"]);
    expect(absentBody.verdict).toBe("write");
    expect(absentBody.reason).toBe("absent");
  });

  it("a manual body reads fresh-manual when phaseLog is absent entirely", () => {
    seedState("omicron", { phaseLog: undefined });
    writeCheckpoint("manual note\n");
    runCapture(["omicron", "--site", "manual"]);
    const r = runCapture(["omicron", "--probe", "--site", "gate"]);
    expect(r.verdict).toBe("preserve");
    expect(r.reason).toBe("fresh-manual");
  });

  it("arming twice leaves checkpoint.md byte-identical and overwrites (not appends) the record", () => {
    seedState("pi");
    const body = "byte-identical body\n";
    writeCheckpoint(body);
    runCapture(["pi", "--site", "manual"]);
    const beforeUpdatedAt = readState("pi", stateDir)?.updatedAt;
    runCapture(["pi", "--site", "plan-review"]);
    expect(
      fs.readFileSync(
        path.join(worktreeRoot, ".flow-tmp", "checkpoint.md"),
        "utf8",
      ),
    ).toBe(body);
    const state = readState("pi", stateDir);
    expect(state?.checkpoint?.site).toBe("plan-review");
    expect(state?.updatedAt).toBe(beforeUpdatedAt); // arming never bumps updatedAt
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
