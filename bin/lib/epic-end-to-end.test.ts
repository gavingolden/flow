/**
 * F5 end-to-end integration: the epic-design wiring + the validator gate +
 * the resume verdicts, exercised through the real surfaces F5 ships (the
 * bare-name validators, `epicDirRelative`, and `flow-epic-resume-decide`'s
 * pure `decide()` / `run()`), with the designer / clarification / gh /
 * flow-open-pr STUBBED.
 *
 * The /epic-create supervisor itself is LLM prose, not callable code, so the
 * "supervisor" here is a thin mechanical driver that performs the same
 * deterministic steps the SKILL.md prescribes — write artifacts at
 * `epicDirRelative(slug)`, run BOTH validators as the gate, open the design PR
 * exactly once via a stubbed `gh`, halt at `epic-design-pending-review`, and
 * never merge / never launch. The validator subprocesses and the resume helper
 * are REAL, so the gate and the resume precedence are genuinely under test.
 *
 * Validators are driven via `spawnSync("bun", [scriptPath, "--validate", ...])`
 * against the source paths — the established `epic-designer-example.test.ts`
 * idiom (a worktree's PATH may not carry the freshly-edited symlinks).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { epicDirRelative } from "./epic-manifest-schema";
import {
  decide as epicDecide,
  run as epicResumeRun,
  type DecisionResult as EpicDecisionResult,
} from "../flow-epic-resume-decide";
import { writeState, readState, type PipelineState } from "./state";
import {
  type GhRunner,
  type GitRunner,
  type WorktreeInfo,
  type PrInfo,
} from "./resume-probes";

const BIN = path.resolve(__dirname, "..");
const DAG_SCRIPT = path.resolve(BIN, "flow-epic-dag.ts");
const SCHEMA_SCRIPT = path.resolve(BIN, "lib", "epic-manifest-schema.ts");

// The committed worked example is a valid, schema- + DAG-passing manifest.
const VALID_MANIFEST_SRC = path.resolve(
  BIN,
  "..",
  ".flow",
  "epics",
  "build-the-epic-designer",
  "manifest.json",
);
const VALID_DESIGN_SRC = path.resolve(
  BIN,
  "..",
  ".flow",
  "epics",
  "build-the-epic-designer",
  "design.md",
);
const CYCLIC_FIXTURE = path.resolve(
  BIN,
  "fixtures",
  "epic-cyclic-manifest.json",
);

function validate(
  script: string,
  manifest: string,
): { status: number; stderr: string } {
  const r = spawnSync("bun", [script, "--validate", manifest], {
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// A thin mechanical "supervisor" modelling the deterministic SKILL.md steps.
// Records side effects (gh / flow-open-pr / designer calls) so the tests can
// assert the wiring contract. NOT an LLM — it runs the validators + writes
// state exactly as the prose prescribes.
// ---------------------------------------------------------------------------

type SideEffects = {
  prCreateCalls: number;
  prMergeCalls: number;
  prCloseCalls: number;
  worktreeRemoveCalls: number;
  featureLaunchCalls: number;
  designerCalls: string[]; // each call's prompt (to assert redirect text)
};

function newSideEffects(): SideEffects {
  return {
    prCreateCalls: 0,
    prMergeCalls: 0,
    prCloseCalls: 0,
    worktreeRemoveCalls: 0,
    featureLaunchCalls: 0,
    designerCalls: [],
  };
}

let workdir!: string;
let stateDir!: string;
let slug!: string;
let epicDir!: string;
let manifestPath!: string;
let designPath!: string;
let fx!: SideEffects;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-e2e-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-e2e-state-"));
  slug = "build-the-epic-designer";
  epicDir = path.join(workdir, epicDirRelative(slug));
  fs.mkdirSync(epicDir, { recursive: true });
  manifestPath = path.join(epicDir, "manifest.json");
  designPath = path.join(epicDir, "design.md");
  fx = newSideEffects();
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** The designer stub: writes design.md + manifest.json under epicDirRelative(slug). */
function runDesignerStub(
  prompt: string,
  manifestSrc = VALID_MANIFEST_SRC,
): void {
  fx.designerCalls.push(prompt);
  fs.copyFileSync(manifestSrc, manifestPath);
  fs.copyFileSync(VALID_DESIGN_SRC, designPath);
}

/** The validator gate: both must exit 0. Returns the verdict. */
function runGate(): { passed: boolean } {
  const schema = validate(SCHEMA_SCRIPT, manifestPath);
  if (schema.status !== 0) return { passed: false };
  const dag = validate(DAG_SCRIPT, manifestPath);
  return { passed: dag.status === 0 };
}

/** The idempotent design-PR open: probes (records) then skips create if a PR exists. */
function openDesignPr(existingPr: number | null): number {
  if (existingPr !== null) {
    // Idempotent read-back — no second `gh pr create`.
    return existingPr;
  }
  fx.prCreateCalls += 1;
  return 42;
}

/**
 * The mechanical happy-path "supervisor": clarify (stubbed-skip) → design →
 * validate → commit (no-op here) → open PR → checkpoint. Returns the terminal
 * phase. Never merges, never launches.
 */
function driveToCheckpoint(prompt: string): { phase: string; pr: number } {
  writeState(
    {
      slug,
      phase: "epic-designing",
      repo: workdir,
      worktree: workdir,
      updatedAt: "t",
    },
    stateDir,
  );
  runDesignerStub(prompt);
  writeState(
    {
      slug,
      phase: "epic-validating",
      repo: workdir,
      worktree: workdir,
      updatedAt: "t",
    },
    stateDir,
  );
  const gate = runGate();
  if (!gate.passed) {
    throw new Error("gate failed — supervisor would loop back to the designer");
  }
  writeState(
    {
      slug,
      phase: "epic-pr-open",
      repo: workdir,
      worktree: workdir,
      updatedAt: "t",
    },
    stateDir,
  );
  const pr = openDesignPr(null);
  writeState(
    {
      slug,
      phase: "epic-design-pending-review",
      repo: workdir,
      worktree: workdir,
      pr,
      updatedAt: "t",
    },
    stateDir,
  );
  return { phase: "epic-design-pending-review", pr };
}

// ---------------------------------------------------------------------------
// Case 1 — happy path
// ---------------------------------------------------------------------------

describe("F5 e2e — happy path", () => {
  it("writes both artifacts, both validators exit 0, PR opened exactly once, terminal epic-design-pending-review, no launch/merge", () => {
    const result = driveToCheckpoint(
      "Use the /epic-create skill for: build the epic designer",
    );

    // Both artifacts exist at epicDirRelative(slug).
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(designPath)).toBe(true);

    // Both validators exit 0 against the written manifest.
    expect(validate(SCHEMA_SCRIPT, manifestPath).status).toBe(0);
    expect(validate(DAG_SCRIPT, manifestPath).status).toBe(0);

    // PR opened exactly once; no merge, no feature launch.
    expect(fx.prCreateCalls).toBe(1);
    expect(fx.prMergeCalls).toBe(0);
    expect(fx.featureLaunchCalls).toBe(0);

    // Terminal state is the checkpoint.
    expect(result.phase).toBe("epic-design-pending-review");
    expect(readState(slug, stateDir)!.phase).toBe("epic-design-pending-review");
  });

  it("the gate rejects a bad graph (cyclic manifest) — happy path fails if the gate is bypassed", () => {
    // Drive the designer to write the CYCLIC fixture; the DAG gate must reject.
    fx.designerCalls.push("cyclic");
    fs.copyFileSync(CYCLIC_FIXTURE, manifestPath);
    const dag = validate(DAG_SCRIPT, manifestPath);
    expect(dag.status).not.toBe(0);
    // A correct supervisor would loop back to the designer, NOT open a PR.
    expect(fx.prCreateCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — redirect
// ---------------------------------------------------------------------------

describe("F5 e2e — redirect re-runs the designer + pushes to the SAME PR (no 2nd create)", () => {
  it("re-invokes the designer with the redirect text and does NOT fire a second pr create", () => {
    const first = driveToCheckpoint(
      "Use the /epic-create skill for: build the epic designer",
    );
    expect(fx.prCreateCalls).toBe(1);

    // Redirect: re-run the designer with the redirect appended, re-validate,
    // re-call openDesignPr — which reads the EXISTING PR back (no 2nd create).
    const redirectPrompt =
      "build the epic designer\n\nUSER REDIRECT (received during epic-design-pending-review): split feature B into read/write";
    runDesignerStub(redirectPrompt);
    expect(runGate().passed).toBe(true);
    const prAfter = openDesignPr(first.pr); // existing PR → read-back

    // The redirect text reached the designer.
    expect(
      fx.designerCalls.some((p) =>
        p.includes("split feature B into read/write"),
      ),
    ).toBe(true);
    // NO second pr create — idempotent re-push to the same branch/PR.
    expect(fx.prCreateCalls).toBe(1);
    expect(prAfter).toBe(first.pr);

    // Checkpoint re-entered.
    writeState(
      {
        slug,
        phase: "epic-design-pending-review",
        repo: workdir,
        worktree: workdir,
        pr: prAfter,
        updatedAt: "t",
      },
      stateDir,
    );
    expect(readState(slug, stateDir)!.phase).toBe("epic-design-pending-review");
  });
});

// ---------------------------------------------------------------------------
// Case 3 — approve
// ---------------------------------------------------------------------------

describe("F5 e2e — approve reaches epic-approved, PR left OPEN, no merge / no launch", () => {
  it("transitions to epic-approved without invoking gh pr merge or launching a feature", () => {
    const result = driveToCheckpoint(
      "Use the /epic-create skill for: build the epic designer",
    );
    expect(result.phase).toBe("epic-design-pending-review");

    // Approve: write epic-approved, leave the PR OPEN, merge nothing.
    writeState(
      {
        slug,
        phase: "epic-approved",
        repo: workdir,
        worktree: workdir,
        pr: result.pr,
        updatedAt: "t",
      },
      stateDir,
    );

    expect(readState(slug, stateDir)!.phase).toBe("epic-approved");
    expect(fx.prMergeCalls).toBe(0); // never merges
    expect(fx.featureLaunchCalls).toBe(0); // never launches
    expect(fx.prCloseCalls).toBe(0); // PR left OPEN (not closed)
  });
});

// ---------------------------------------------------------------------------
// Case 4 — cancel
// ---------------------------------------------------------------------------

describe("F5 e2e — cancel closes the PR + removes the worktree, phase cancelled", () => {
  it("fires gh pr close + flow-remove-worktree and writes phase cancelled", () => {
    const result = driveToCheckpoint(
      "Use the /epic-create skill for: build the epic designer",
    );

    // Cancel: gh pr close, flow-remove-worktree, phase cancelled.
    fx.prCloseCalls += 1; // gh pr close <pr>
    fx.worktreeRemoveCalls += 1; // flow-remove-worktree
    writeState(
      {
        slug,
        phase: "cancelled",
        repo: workdir,
        worktree: workdir,
        pr: result.pr,
        updatedAt: "t",
      },
      stateDir,
    );

    expect(fx.prCloseCalls).toBe(1);
    expect(fx.worktreeRemoveCalls).toBe(1);
    expect(fx.prMergeCalls).toBe(0);
    expect(readState(slug, stateDir)!.phase).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Case 5 — resume at the checkpoint (no re-design, no 2nd create)
// ---------------------------------------------------------------------------

describe("F5 e2e — resume at the checkpoint re-renders WITHOUT re-designing", () => {
  it("flow-epic-resume-decide returns 'checkpoint' (worktree + PR present) and the designer is NOT re-invoked", () => {
    // State as a crash at epic-design-pending-review would leave it.
    writeState(
      {
        slug,
        phase: "epic-design-pending-review",
        repo: workdir,
        worktree: workdir,
        pr: 42,
        updatedAt: "t",
      },
      stateDir,
    );
    // The artifacts already exist on disk (designer ran before the crash).
    fs.copyFileSync(VALID_MANIFEST_SRC, manifestPath);
    fs.copyFileSync(VALID_DESIGN_SRC, designPath);

    // Drive decide() directly (worktree present + open PR).
    const present: WorktreeInfo = { kind: "present", path: workdir };
    const openPr: PrInfo = {
      kind: "found",
      state: "OPEN",
      number: 42,
      url: "https://x/y/pull/42",
    };
    const verdict = epicDecide({
      slug,
      state: readState(slug, stateDir) as PipelineState,
      worktree: present,
      pr: openPr,
    });
    expect(verdict.epicResumeAt).toBe("checkpoint");

    // The resume re-renders the checkpoint; it does NOT re-run the designer
    // and does NOT fire a second pr create.
    expect(fx.designerCalls.length).toBe(0);
    expect(fx.prCreateCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — resume mid-epic-pr-open reads the existing PR back (NOT open-pr)
// ---------------------------------------------------------------------------

describe("F5 e2e — resume mid-epic-pr-open reads the existing PR back", () => {
  it("flow-epic-resume-decide returns 'read-back-pr' (NOT 'open-pr') when a branch PR already exists", () => {
    writeState(
      {
        slug,
        phase: "epic-pr-open",
        repo: workdir,
        worktree: workdir,
        updatedAt: "t",
      },
      stateDir,
    );

    // run() integration with a real-on-disk worktree + stubbed gh/git: the
    // branch already has a PR, so the verdict must be read-back-pr.
    spawnSync("git", ["init", "-b", "main"], { cwd: workdir });
    spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: workdir });
    spawnSync("git", ["config", "user.name", "T"], { cwd: workdir });
    spawnSync("git", ["commit", "--allow-empty", "-m", "feat: initial"], {
      cwd: workdir,
    });

    const git: GitRunner = (argv) => {
      if (argv[0] === "rev-parse")
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[0] === "branch")
        return { stdout: "epic-branch\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const gh: GhRunner = () => ({
      stdout: JSON.stringify({
        number: 42,
        state: "OPEN",
        url: "https://x/y/pull/42",
      }),
      stderr: "",
      exitCode: 0,
    });

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const exit = epicResumeRun([slug], { stateDir, gh, git });
    spy.mockRestore();

    expect(exit).toBe(0);
    const verdict = JSON.parse(writes.join("")) as EpicDecisionResult;
    expect(verdict.epicResumeAt).toBe("read-back-pr");
    expect(verdict.epicResumeAt).not.toBe("open-pr");
    // Reading back means NO second pr create fires.
    expect(fx.prCreateCalls).toBe(0);
  });
});
