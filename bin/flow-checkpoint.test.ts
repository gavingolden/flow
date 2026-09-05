import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveCheckpointBody,
  armBannerPath,
  checkpointBodyPath,
  checkpointConsumedPath,
  checkpointDir,
  checkpointMarkerPath,
  parseArgs,
  probeCheckpointBody,
  renderArmBanner,
  run,
  type CheckpointResult,
} from "./flow-checkpoint";
import { isCheckpointUsable, probeFreshness } from "./lib/checkpoint-freshness";
import {
  readState,
  writeState,
  type PipelineKind,
  type PipelineState,
} from "./lib/state";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-checkpoint-state-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seedState(slug: string, overrides: Partial<PipelineState> = {}): void {
  writeState(
    {
      slug,
      phase: "checkpoint-pending-clear",
      repo: "/tmp/repo",
      worktree: "/tmp/some-worktree-path",
      updatedAt: "2026-06-30T12:00:00Z",
      ...overrides,
    },
    stateDir,
  );
}

function writeCheckpoint(
  slug: string,
  body = "approved with condition X\n",
): void {
  const p = checkpointBodyPath(slug, stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function markerFile(slug: string): string {
  return checkpointMarkerPath(slug, stateDir);
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

// Sibling of captureStdout(): no stderr capture existed before this PR, so
// the pre-existing terminal-warning suite (`run() — ready-path terminal-
// phase warning`) let the real process.stderr.write through unmocked.
function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

function runCapture(
  argv: string[],
  slug?: string,
  resolveKind: () => PipelineKind | null = () => null,
): CheckpointResult & { exit: number } {
  const { writes, restore } = captureStdout();
  const exit = run(argv, {
    stateDir,
    resolveSlug: () => slug ?? null,
    resolveKind,
  });
  restore();
  const result = JSON.parse(writes.join("")) as CheckpointResult;
  return { ...result, exit };
}

// stdout+stderr twin of runCapture(): the caller wants both the parsed JSON
// verdict AND the raw stderr lines (the arm banner, the terminal warning).
function runCaptureBoth(
  argv: string[],
  slug?: string,
  resolveKind: () => PipelineKind | null = () => null,
): CheckpointResult & {
  exit: number;
  stdoutRaw: string;
  stderrLines: string[];
} {
  const out = captureStdout();
  const err = captureStderr();
  const exit = run(argv, {
    stateDir,
    resolveSlug: () => slug ?? null,
    resolveKind,
  });
  out.restore();
  err.restore();
  const stdoutRaw = out.writes.join("");
  const result = JSON.parse(stdoutRaw) as CheckpointResult;
  return { ...result, exit, stdoutRaw, stderrLines: err.writes };
}

describe("probeCheckpointBody", () => {
  it("is false when checkpoint.md is missing", () => {
    expect(probeCheckpointBody("no-body-slug", stateDir)).toBe(false);
  });

  it("is false when checkpoint.md is empty", () => {
    const p = checkpointBodyPath("empty-body-slug", stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
    expect(probeCheckpointBody("empty-body-slug", stateDir)).toBe(false);
  });

  it("is true when checkpoint.md is present and non-empty", () => {
    writeCheckpoint("has-body-slug");
    expect(probeCheckpointBody("has-body-slug", stateDir)).toBe(true);
  });
});

describe("parseArgs", () => {
  it("treats empty argv as slug-omitted, consume off, probe off, path off, site manual", () => {
    expect(parseArgs([])).toEqual({
      slug: undefined,
      consume: false,
      probe: false,
      path: false,
      site: "manual",
    });
  });

  it("accepts a positional slug", () => {
    expect(parseArgs(["my-slug"])).toEqual({
      slug: "my-slug",
      consume: false,
      probe: false,
      path: false,
      site: "manual",
    });
  });

  it("accepts --consume in either order", () => {
    expect(parseArgs(["--consume"])).toEqual({
      slug: undefined,
      consume: true,
      probe: false,
      path: false,
      site: "manual",
    });
    expect(parseArgs(["my-slug", "--consume"])).toEqual({
      slug: "my-slug",
      consume: true,
      probe: false,
      path: false,
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
      path: false,
      site: "gate",
    });
  });

  it("rejects an unknown --site value", () => {
    expect(parseArgs(["--site", "bogus"])).toEqual({
      error: "unknown --site value: bogus",
    });
  });

  it("accepts a new terminal --site value", () => {
    expect(parseArgs(["--site", "terminal"])).toEqual({
      slug: undefined,
      consume: false,
      probe: false,
      path: false,
      site: "terminal",
    });
  });

  it("rejects --probe combined with --consume", () => {
    expect(parseArgs(["--probe", "--consume"])).toEqual({
      error: "--probe and --consume are mutually exclusive",
    });
  });

  it("accepts --path", () => {
    expect(parseArgs(["my-slug", "--path"])).toEqual({
      slug: "my-slug",
      consume: false,
      probe: false,
      path: true,
      site: "manual",
    });
  });

  it("rejects --path combined with --consume", () => {
    expect(parseArgs(["--path", "--consume"])).toEqual({
      error: "--path is mutually exclusive with --consume/--probe",
    });
  });

  it("rejects --path combined with --probe", () => {
    expect(parseArgs(["--path", "--probe"])).toEqual({
      error: "--path is mutually exclusive with --consume/--probe",
    });
  });
});

describe("run() — --path", () => {
  it("prints the absolute checkpoint.md path and exits 0 with NO state.json present", () => {
    const { writes, restore } = captureStdout();
    const exit = run(["never-seen-slug", "--path"], {
      stateDir,
      resolveSlug: () => null,
    });
    restore();
    expect(exit).toBe(0);
    expect(writes.join("").trim()).toBe(
      checkpointBodyPath("never-seen-slug", stateDir),
    );
  });

  it("creates the parent directory so a `> $(flow-checkpoint --path)` redirect works on a never-checkpointed slug", () => {
    // The three terminal auto-checkpoint sites in flow-pipeline/SKILL.md write
    // the body with a bare shell redirect into this path. `checkpointDir` is
    // deliberately mkdir-free and the arm path's own mkdir runs only AFTER a
    // body already exists, so without this the redirect fails with ENOENT and
    // the terminal site silently never arms — for exactly the never-
    // checkpointed pipelines it was added to serve.
    const { writes, restore } = captureStdout();
    const exit = run(["fresh-slug", "--path"], {
      stateDir,
      resolveSlug: () => null,
    });
    restore();
    const printed = writes.join("").trim();
    expect(exit).toBe(0);
    expect(fs.existsSync(path.dirname(printed))).toBe(true);
    // The redirect the supervisor prose actually performs must now succeed.
    expect(() => fs.writeFileSync(printed, "residue\n")).not.toThrow();
    expect(fs.readFileSync(printed, "utf8")).toBe("residue\n");
  });

  it("prints the same path regardless of whether state.worktree is live, deleted, or unset", () => {
    seedState("path-a", { worktree: "/does/not/exist" });
    seedState("path-b", { worktree: undefined });
    const { writes: writesA, restore: restoreA } = captureStdout();
    run(["path-a", "--path"], { stateDir, resolveSlug: () => null });
    restoreA();
    const { writes: writesB, restore: restoreB } = captureStdout();
    run(["path-b", "--path"], { stateDir, resolveSlug: () => null });
    restoreB();
    expect(writesA.join("").trim()).toBe(
      checkpointBodyPath("path-a", stateDir),
    );
    expect(writesB.join("").trim()).toBe(
      checkpointBodyPath("path-b", stateDir),
    );
  });
});

describe("run() — ready / needs", () => {
  it("ready verdict (exit 0) + writes the .pending marker when checkpoint.md + state.json are present", () => {
    seedState("alpha");
    writeCheckpoint("alpha");
    const r = runCapture(["alpha"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(r.marker).toBe(markerFile("alpha"));
    expect(fs.existsSync(markerFile("alpha"))).toBe(true);
  });

  it("needs verdict + writes NO marker when checkpoint.md is missing", () => {
    seedState("beta");
    const r = runCapture(["beta"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("needs");
    expect(r.reason).toBe("checkpoint-missing");
    expect(fs.existsSync(markerFile("beta"))).toBe(false);
  });

  it("needs verdict (state-missing) when the state file is absent", () => {
    const r = runCapture(["ghost"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("needs");
    expect(r.reason).toBe("state-missing");
    expect(fs.existsSync(markerFile("ghost"))).toBe(false);
  });

  it("auto-resolves the slug from the pane resolver when omitted", () => {
    seedState("gamma");
    writeCheckpoint("gamma");
    const r = runCapture([], "gamma");
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(r.slug).toBe("gamma");
  });

  it("arms successfully at a phase with no worktree (e.g. starting) — the state-dir location needs none", () => {
    seedState("no-wt-starting", { phase: "starting", worktree: undefined });
    writeCheckpoint("no-wt-starting");
    const r = runCapture(["no-wt-starting"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(r.reason).toBeUndefined();
    expect(fs.existsSync(markerFile("no-wt-starting"))).toBe(true);
  });

  it("arms successfully at a terminal phase with no worktree (e.g. merged, worktree already removed)", () => {
    seedState("no-wt-merged", { phase: "merged", worktree: undefined });
    writeCheckpoint("no-wt-merged");
    const r = runCapture(["no-wt-merged"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(fs.existsSync(markerFile("no-wt-merged"))).toBe(true);
  });
});

describe("run() — ready-path terminal-phase warning (Task 7)", () => {
  it("(a) epic-approved with no resolvable kind: ready, marker written, warning present and names the phase", () => {
    seedState("epic-terminal", { phase: "epic-approved" });
    writeCheckpoint("epic-terminal");
    const r = runCapture(["epic-terminal"], undefined, () => null);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(fs.existsSync(markerFile("epic-terminal"))).toBe(true);
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain("epic-approved");
  });

  it("(b) gated: ready, marker written, warning ABSENT (the feedback-resume carve-out)", () => {
    seedState("gated-epic", { phase: "gated" });
    writeCheckpoint("gated-epic");
    const r = runCapture(["gated-epic"], undefined, () => null);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(fs.existsSync(markerFile("gated-epic"))).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("(c) a non-terminal epic phase and a non-terminal feature phase: warning absent", () => {
    for (const phase of ["epic-design-pending-review", "implementing"]) {
      seedState("non-terminal", { phase });
      writeCheckpoint("non-terminal");
      const r = runCapture(["non-terminal"], undefined, () => null);
      expect(r.status, phase).toBe("ready");
      expect(r.warning, phase).toBeUndefined();
      fs.rmSync(markerFile("non-terminal"), { force: true });
    }
  });

  it("(d) merged: warning present", () => {
    seedState("merged-epic", { phase: "merged" });
    writeCheckpoint("merged-epic");
    const r = runCapture(["merged-epic"], undefined, () => null);
    expect(r.status).toBe("ready");
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain("merged");
  });

  it("(e) epic-approved with resolveKind() === 'epic-run': warning ABSENT — the run window WILL auto-resume, so warning there is a false alarm", () => {
    seedState("run-window", { phase: "epic-approved" });
    writeCheckpoint("run-window");
    const r = runCapture(["run-window"], undefined, () => "epic-run");
    expect(r.status).toBe("ready");
    expect(fs.existsSync(markerFile("run-window"))).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});

describe("run() — --consume", () => {
  it("removes an existing .pending marker and reports consumed", () => {
    seedState("delta");
    fs.mkdirSync(path.dirname(markerFile("delta")), { recursive: true });
    fs.writeFileSync(markerFile("delta"), "delta\n");
    const r = runCapture(["delta", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("consumed");
    expect(fs.existsSync(markerFile("delta"))).toBe(false);
  });

  it("is a no-op when no marker is present", () => {
    seedState("epsilon");
    const r = runCapture(["epsilon", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("no-marker");
  });

  it("is a no-op (state-missing) when state.json is absent", () => {
    const r = runCapture(["ghost-consume", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("state-missing");
  });

  it("archives the body and clears state.checkpoint when state.worktree points at a deleted directory", () => {
    const deletedWt = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-checkpoint-deleted-wt-"),
    );
    fs.rmSync(deletedWt, { recursive: true, force: true });
    seedState("gone-wt", { phase: "merged", worktree: deletedWt });
    writeCheckpoint("gone-wt", "orphaned by a deleted worktree\n");
    runCapture(["gone-wt", "--site", "manual"]); // arm
    const r = runCapture(["gone-wt", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("consumed");
    expect(readState("gone-wt", stateDir)?.checkpoint).toBeUndefined();
    expect(fs.existsSync(checkpointConsumedPath("gone-wt", stateDir))).toBe(
      true,
    );
  });
});

describe("run() — --consume archives the body", () => {
  it("archives checkpoint.md, clears the freshness record, and a later --probe --site gate returns write (the reported scenario)", () => {
    seedState("zeta");
    writeCheckpoint("zeta", "plan-approval body\n");
    runCapture(["zeta", "--site", "plan-approval"]); // arm
    const consumeResult = runCapture(["zeta", "--consume"]);
    expect(consumeResult.exit).toBe(0);
    expect(fs.existsSync(checkpointBodyPath("zeta", stateDir))).toBe(false);
    expect(fs.existsSync(checkpointConsumedPath("zeta", stateDir))).toBe(true);
    expect(
      fs.readFileSync(checkpointConsumedPath("zeta", stateDir), "utf8"),
    ).toBe("plan-approval body\n");
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

    // Force the rename inside archiveCheckpointBody to fail by pre-occupying
    // the destination with a non-empty directory (ENOTEMPTY on rename).
    const dest = checkpointConsumedPath("eta", stateDir);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "keep"), "x");
    writeCheckpoint("eta", "body\n");
    const archived = archiveCheckpointBody("eta", stateDir);
    expect(archived).toBeNull();
    expect(fs.existsSync(checkpointBodyPath("eta", stateDir))).toBe(false); // unlinked despite the failed rename
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("archives a present body even with no marker (marker-independent archiving), and reports the archived path", () => {
    seedState("theta-noop");
    writeCheckpoint("theta-noop", "orphaned body\n");
    // No arm this run, so no marker exists — --consume must still archive
    // the body unconditionally rather than skipping because there is
    // "nothing to consume" from the marker's point of view.
    const r = runCapture(["theta-noop", "--consume"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("no-marker");
    expect(r.archived).toBe(checkpointConsumedPath("theta-noop", stateDir));
    expect(fs.existsSync(checkpointBodyPath("theta-noop", stateDir))).toBe(
      false,
    );
    expect(fs.existsSync(checkpointConsumedPath("theta-noop", stateDir))).toBe(
      true,
    );
    expect(
      fs.readFileSync(checkpointConsumedPath("theta-noop", stateDir), "utf8"),
    ).toBe("orphaned body\n");
  });
});

describe("probeFreshness / --probe", () => {
  function phaseLog(...entries: Array<{ phase: string; at: string }>) {
    return entries;
  }

  it("returns write (auto-refresh) when the never-cleared auto-site leaks past a later phase advance", () => {
    seedState("theta");
    writeCheckpoint("theta", "auto body\n");
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
    writeCheckpoint("iota", "manual note\n");
    runCapture(["iota", "--site", "manual"]);
    const r = runCapture(["iota", "--probe", "--site", "gate"]);
    expect(r.verdict).toBe("preserve");
    expect(r.reason).toBe("fresh-manual");
  });

  it("writes over a manual note once the phase has advanced since it was armed", () => {
    seedState("kappa");
    writeCheckpoint("kappa", "manual note\n");
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
    expect(r.reason).toBe(
      `stale-manual:${(r.record as { phase: string }).phase}`,
    );
    expect(r.record).toMatchObject({ site: "manual" });
  });

  it("record-less body: mtime after the newest phaseLog entry preserves, before it writes", () => {
    seedState("lambda", {
      phaseLog: phaseLog({
        phase: "implementing",
        at: "2020-01-01T00:00:00.000Z",
      }),
    });
    writeCheckpoint("lambda", "unrecorded body\n");
    const fresh = runCapture(["lambda", "--probe", "--site", "gate"]);
    expect(fresh.verdict).toBe("preserve");
    expect(fresh.reason).toBe("fresh-unrecorded");

    seedState("mu", {
      phaseLog: phaseLog({
        phase: "implementing",
        at: "2099-01-01T00:00:00.000Z",
      }),
    });
    writeCheckpoint("mu", "unrecorded body\n");
    const stale = runCapture(["mu", "--probe", "--site", "gate"]);
    expect(stale.verdict).toBe("write");
    expect(stale.reason).toBe("stale-unrecorded");
  });

  it("fails open to write on missing state or an absent checkpoint.md — a missing worktree no longer short-circuits (no-worktree removed)", () => {
    const missingState = runCapture([
      "ghost-probe",
      "--probe",
      "--site",
      "gate",
    ]);
    expect(missingState.exit).toBe(0);
    expect(missingState.verdict).toBe("write");
    expect(missingState.reason).toBe("state-missing");

    seedState("nu", { worktree: undefined });
    const noWorktreeNoBody = runCapture(["nu", "--probe", "--site", "gate"]);
    expect(noWorktreeNoBody.verdict).toBe("write");
    expect(noWorktreeNoBody.reason).toBe("absent");

    seedState("nu2", { worktree: undefined });
    writeCheckpoint("nu2", "note\n");
    const noWorktreeWithBody = runCapture(["nu2", "--probe", "--site", "gate"]);
    expect(noWorktreeWithBody.verdict).toBe("preserve");

    seedState("xi");
    const absentBody = runCapture(["xi", "--probe", "--site", "gate"]);
    expect(absentBody.verdict).toBe("write");
    expect(absentBody.reason).toBe("absent");
  });

  it("a manual body reads fresh-manual when phaseLog is absent entirely", () => {
    seedState("omicron", { phaseLog: undefined });
    writeCheckpoint("omicron", "manual note\n");
    runCapture(["omicron", "--site", "manual"]);
    const r = runCapture(["omicron", "--probe", "--site", "gate"]);
    expect(r.verdict).toBe("preserve");
    expect(r.reason).toBe("fresh-manual");
  });

  it("re-arming with an auto site never relabels a fresh manual record's provenance (no phase change)", () => {
    // A fresh manual note (preserve verdict) outranks a later auto-site arm
    // with no intervening phase change — the auto arm must not stomp the
    // `site: "manual"` provenance the preserve decision rests on, or the
    // note would silently stop outranking auto sites on the NEXT probe.
    seedState("pi");
    const body = "byte-identical body\n";
    writeCheckpoint("pi", body);
    runCapture(["pi", "--site", "manual"]);
    const beforeUpdatedAt = readState("pi", stateDir)?.updatedAt;
    runCapture(["pi", "--site", "plan-review"]);
    expect(fs.readFileSync(checkpointBodyPath("pi", stateDir), "utf8")).toBe(
      body,
    );
    const state = readState("pi", stateDir);
    expect(state?.checkpoint?.site).toBe("manual");
    expect(state?.updatedAt).toBe(beforeUpdatedAt); // arming never bumps updatedAt
  });

  it("re-arming with a second auto site DOES relabel the record (rule 5: auto may overwrite auto)", () => {
    seedState("rho");
    const body = "auto body\n";
    writeCheckpoint("rho", body);
    runCapture(["rho", "--site", "plan-approval"]);
    runCapture(["rho", "--site", "gate"]);
    const state = readState("rho", stateDir);
    expect(state?.checkpoint?.site).toBe("gate");
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

// The two freshness predicates answer deliberately different questions, and
// nothing else pins that apart: probeFreshness answers "may this site clobber
// the body?" (an auto record is always clobberable by a later auto site), while
// isCheckpointUsable answers "is there anything here worth re-injecting?" (an
// auto record is usable until a phase transition supersedes it). Conflating the
// two is the regression fixed in 0ad949c — step-4 approval addenda were dropped
// on resume because the arm-time verdict was reused as the usability signal.
describe("probeFreshness vs isCheckpointUsable — intentional divergence", () => {
  it("diverges on a fresh auto record: not preserved, but still usable", () => {
    seedState("drift", {
      checkpoint: {
        site: "plan-approval",
        phase: "checkpoint-pending-clear",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ phase: "planning", at: "2026-06-30T11:00:00.000Z" }],
    });
    writeCheckpoint("drift");
    const state = readState("drift", stateDir)!;

    expect(probeFreshness(state, "gate", stateDir).verdict).toBe("write");
    expect(isCheckpointUsable(state, stateDir)).toBe(true);
  });

  it("agrees once a later phase transition supersedes the auto record", () => {
    seedState("drift", {
      checkpoint: {
        site: "plan-approval",
        phase: "checkpoint-pending-clear",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ phase: "implementing", at: "2026-06-30T13:00:00.000Z" }],
    });
    writeCheckpoint("drift");
    const state = readState("drift", stateDir)!;

    expect(probeFreshness(state, "gate", stateDir).verdict).toBe("write");
    expect(isCheckpointUsable(state, stateDir)).toBe(false);
  });

  it("agrees a fresh manual record is both preserved and usable", () => {
    seedState("drift", {
      checkpoint: {
        site: "manual",
        phase: "gated",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ phase: "gating", at: "2026-06-30T11:00:00.000Z" }],
    });
    writeCheckpoint("drift");
    const state = readState("drift", stateDir)!;

    expect(probeFreshness(state, "gate", stateDir).verdict).toBe("preserve");
    expect(isCheckpointUsable(state, stateDir)).toBe(true);
  });
});

describe("renderArmBanner()", () => {
  it("true branch renders the exact site-bearing string", () => {
    expect(renderArmBanner({ armed: true, site: "manual" })).toBe(
      "checkpointed: true — site=manual — safe to /clear",
    );
  });

  it("false branch renders the exact reason-bearing string", () => {
    expect(
      renderArmBanner({ armed: false, reason: "checkpoint-missing" }),
    ).toBe(
      "checkpointed: false — checkpoint-missing — /clear will lose unsaved in-chat state",
    );
  });

  it("never contains 'phase=' or 'armed=' in either branch", () => {
    const trueLine = renderArmBanner({ armed: true, site: "terminal" });
    const falseLine = renderArmBanner({ armed: false, reason: "no-slug" });
    expect(trueLine).not.toContain("phase=");
    expect(trueLine).not.toContain("armed=");
    expect(falseLine).not.toContain("phase=");
    expect(falseLine).not.toContain("armed=");
  });

  it("never contains emoji in either branch", () => {
    const trueLine = renderArmBanner({ armed: true, site: "gate" });
    const falseLine = renderArmBanner({ armed: false, reason: "bad-args" });
    // Matches any character outside the Basic Multilingual Plane's common
    // text range — a cheap emoji smell test without a full Unicode
    // emoji-property regex dependency.
    const emojiIsh = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
    expect(emojiIsh.test(trueLine)).toBe(false);
    expect(emojiIsh.test(falseLine)).toBe(false);
  });

  it("has no trailing newline in either branch", () => {
    expect(renderArmBanner({ armed: true, site: "manual" })).not.toMatch(/\n$/);
    expect(
      renderArmBanner({ armed: false, reason: "state-missing" }),
    ).not.toMatch(/\n$/);
  });
});

describe("armBannerPath()", () => {
  it("resolves to last-arm-banner.txt inside the slug's checkpoint dir", () => {
    expect(armBannerPath("iota", stateDir)).toBe(
      path.join(checkpointDir("iota", stateDir), "last-arm-banner.txt"),
    );
  });

  it("honours an explicit stateDir override", () => {
    // Pure path.join under the hood — no directory needs to exist on disk,
    // so a literal placeholder string is enough; this used to pay a real
    // mkdtemp/rmSync round-trip for a computation that never touches fs.
    const otherDir = "/does/not/exist/flow-checkpoint-other-state";
    expect(armBannerPath("iota", otherDir)).toBe(
      path.join(checkpointDir("iota", otherDir), "last-arm-banner.txt"),
    );
    expect(armBannerPath("iota", otherDir)).not.toBe(
      armBannerPath("iota", stateDir),
    );
  });
});

describe("run() — arm banner on stderr", () => {
  it("ready arm prints a 'checkpointed: true' banner naming the site", () => {
    seedState("banner-ready");
    writeCheckpoint("banner-ready");
    const r = runCaptureBoth(["banner-ready", "--site", "gate"]);
    expect(r.status).toBe("ready");
    const bannerLines = r.stderrLines.filter((l) =>
      l.startsWith("checkpointed: "),
    );
    expect(bannerLines).toHaveLength(1);
    expect(bannerLines[0]).toBe(
      "checkpointed: true — site=gate — safe to /clear\n",
    );
  });

  it("state-missing needs arm prints a 'checkpointed: false' banner with that reason", () => {
    const r = runCaptureBoth(["banner-state-missing"]);
    expect(r.status).toBe("needs");
    const bannerLines = r.stderrLines.filter((l) =>
      l.startsWith("checkpointed: "),
    );
    expect(bannerLines).toEqual([
      "checkpointed: false — state-missing — /clear will lose unsaved in-chat state\n",
    ]);
  });

  it("checkpoint-missing needs arm prints a 'checkpointed: false' banner with that reason", () => {
    seedState("banner-checkpoint-missing");
    const r = runCaptureBoth(["banner-checkpoint-missing"]);
    expect(r.status).toBe("needs");
    const bannerLines = r.stderrLines.filter((l) =>
      l.startsWith("checkpointed: "),
    );
    expect(bannerLines).toEqual([
      "checkpointed: false — checkpoint-missing — /clear will lose unsaved in-chat state\n",
    ]);
  });

  it("marker-write-failed needs arm prints a 'checkpointed: false' banner with that reason", () => {
    seedState("banner-marker-fail");
    writeCheckpoint("banner-marker-fail");
    // Force fs.writeFileSync (the marker write) to fail without touching the
    // banner-file write, by pre-occupying the marker path with a directory.
    fs.mkdirSync(markerFile("banner-marker-fail"), { recursive: true });
    const r = runCaptureBoth(["banner-marker-fail"]);
    expect(r.status).toBe("needs");
    const bannerLines = r.stderrLines.filter((l) =>
      l.startsWith("checkpointed: "),
    );
    expect(bannerLines).toHaveLength(1);
    expect(bannerLines[0]).toMatch(
      /^checkpointed: false — marker-write-failed:.* — \/clear will lose unsaved in-chat state\n$/,
    );
  });

  it("no-slug bad-arg path prints a 'checkpointed: false — no-slug' banner as the LAST write, ordered against the preceding console.error usage lines", () => {
    // Record BOTH streams into one ordered array instead of mocking
    // console.error away: under Bun/vitest, console.error does not route
    // through process.stderr.write the way plain Node does, so a
    // process.stderr.write-only spy silently drops the usage lines and the
    // previous version of this test could never actually observe them —
    // it asserted "banner present" against an array that could only ever
    // contain the banner, which is true regardless of ordering.
    const order: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      order.push(args.join(" "));
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s) => {
        order.push(s.toString());
        return true;
      });
    const exit = run([], { stateDir, resolveSlug: () => null });
    writeSpy.mockRestore();
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(order.length).toBeGreaterThanOrEqual(2);
    const last = order[order.length - 1];
    expect(last).toBe(
      "checkpointed: false — no-slug — /clear will lose unsaved in-chat state\n",
    );
  });

  it("bad-args parse-error path prints a 'checkpointed: false — bad-args' banner as the LAST write, ordered against the preceding console.error usage lines", () => {
    const order: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      order.push(args.join(" "));
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s) => {
        order.push(s.toString());
        return true;
      });
    const exit = run(["--bogus"], { stateDir, resolveSlug: () => "x" });
    writeSpy.mockRestore();
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(order.length).toBeGreaterThanOrEqual(2);
    const last = order[order.length - 1];
    expect(last).toBe(
      "checkpointed: false — bad-args — /clear will lose unsaved in-chat state\n",
    );
  });

  it("when the terminal-phase warning also fires, the arm banner is the LAST stderr line", () => {
    seedState("banner-and-warning", { phase: "merged" });
    writeCheckpoint("banner-and-warning");
    const r = runCaptureBoth(["banner-and-warning"], undefined, () => null);
    expect(r.status).toBe("ready");
    expect(r.warning).toBeDefined();
    expect(r.stderrLines.length).toBeGreaterThanOrEqual(2);
    const last = r.stderrLines[r.stderrLines.length - 1];
    expect(last.startsWith("checkpointed: true")).toBe(true);
  });

  // Regression coverage for the confidence-85 finding: the no-slug/bad-args
  // banners were bundled in ahead of the flag dispatch, so a --probe/
  // --consume/--path invocation with bad args or no ambient slug leaked a
  // "checkpointed: false" banner despite renderArmBanner's own documented
  // "never called from --probe/--consume/--path" invariant. Every prior
  // no-slug/bad-args test above passed an explicit slug (or none at all,
  // for a plain arm call), so none of them ever exercised a read-only
  // invocation through this branch.
  it("--probe with no ambient slug does NOT leak a 'checkpointed:' banner", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = captureStderr();
    const exit = run(["--probe", "--site", "gate"], {
      stateDir,
      resolveSlug: () => null,
    });
    err.restore();
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(err.writes.some((l) => l.startsWith("checkpointed: "))).toBe(false);
  });

  it("--path with no ambient slug does NOT leak a 'checkpointed:' banner", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = captureStderr();
    const exit = run(["--path"], { stateDir, resolveSlug: () => null });
    err.restore();
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(err.writes.some((l) => l.startsWith("checkpointed: "))).toBe(false);
  });

  it("--consume with a malformed --site value does NOT leak a 'checkpointed:' banner", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = captureStderr();
    const exit = run(["x", "--consume", "--site", "bogus-site"], {
      stateDir,
      resolveSlug: () => "x",
    });
    err.restore();
    errSpy.mockRestore();
    expect(exit).toBe(2);
    expect(err.writes.some((l) => l.startsWith("checkpointed: "))).toBe(false);
  });
});

describe("run() — stdout purity (byte-identity regression guard)", () => {
  it("--site ready arm emits byte-identical stdout with or without the stderr banner change", () => {
    seedState("purity-ready");
    writeCheckpoint("purity-ready");
    const r = runCaptureBoth(["purity-ready", "--site", "manual"]);
    // runCapture() already JSON.parses stdout (so any stray byte anywhere
    // red-lines it implicitly); this test pins the raw string shape
    // explicitly rather than incidentally, per the contract.
    expect(r.stdoutRaw).toBe(JSON.stringify(JSON.parse(r.stdoutRaw)) + "\n");
    expect(r.stdoutRaw).not.toContain("checkpointed:");
  });

  it("needs arms (state-missing / checkpoint-missing) emit stdout with no 'checkpointed:' substring", () => {
    const stateMissing = runCaptureBoth(["purity-needs-a"]);
    expect(stateMissing.stdoutRaw).not.toContain("checkpointed:");
    seedState("purity-needs-b");
    const checkpointMissing = runCaptureBoth(["purity-needs-b"]);
    expect(checkpointMissing.stdoutRaw).not.toContain("checkpointed:");
  });

  it("--probe writes NO 'checkpointed: ' line to stderr", () => {
    seedState("purity-probe");
    writeCheckpoint("purity-probe");
    const r = runCaptureBoth(["purity-probe", "--probe", "--site", "gate"]);
    expect(r.status).toBe("probe");
    expect(r.stderrLines.some((l) => l.includes("checkpointed: "))).toBe(false);
  });

  it("--consume writes NO 'checkpointed: ' line to stderr", () => {
    seedState("purity-consume");
    writeCheckpoint("purity-consume");
    runCaptureBoth(["purity-consume", "--site", "manual"]); // arm first
    const r = runCaptureBoth(["purity-consume", "--consume"]);
    expect(r.status).toBe("consumed");
    expect(r.stderrLines.some((l) => l.includes("checkpointed: "))).toBe(false);
  });

  it("--path writes NO 'checkpointed: ' line to stderr", () => {
    const err = captureStderr();
    const out = captureStdout();
    run(["purity-path", "--path"], { stateDir, resolveSlug: () => null });
    out.restore();
    err.restore();
    expect(err.writes.some((l) => l.includes("checkpointed: "))).toBe(false);
  });
});

describe("run() — durable arm-banner file", () => {
  it("writes the rendered banner to armBannerPath on a successful arm", () => {
    seedState("durable-ready");
    writeCheckpoint("durable-ready");
    const r = runCapture(["durable-ready", "--site", "plan-review"]);
    expect(r.status).toBe("ready");
    const bannerFile = armBannerPath("durable-ready", stateDir);
    expect(fs.existsSync(bannerFile)).toBe(true);
    expect(fs.readFileSync(bannerFile, "utf8")).toBe(
      "checkpointed: true — site=plan-review — safe to /clear\n",
    );
  });

  it("a banner-file write failure still exits 0 with normal JSON (best-effort)", () => {
    seedState("durable-fail");
    writeCheckpoint("durable-fail");
    // Pre-occupy the banner file's path with a directory so the write fails.
    const bannerFile = armBannerPath("durable-fail", stateDir);
    fs.mkdirSync(bannerFile, { recursive: true });
    const r = runCaptureBoth(["durable-fail", "--site", "manual"]);
    expect(r.exit).toBe(0);
    expect(r.status).toBe("ready");
    expect(r.marker).toBe(markerFile("durable-fail"));
    // The stderr banner still fires even though the durable copy failed.
    expect(r.stderrLines.some((l) => l.startsWith("checkpointed: true"))).toBe(
      true,
    );
  });
});
