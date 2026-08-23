import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoResumesAfterClear,
  AWAITING_HUMAN_PHASES,
  deleteState,
  EPIC_PHASES,
  FINISHED_PHASES,
  isAllowedTerminalExit,
  isEpicPhase,
  isLegitimateEndPhase,
  isMainStateFile,
  isPipelineKind,
  isPipelinePhase,
  listStates,
  PENDING_PHASES,
  PHASE_MODEL_FIELDS,
  PHASE_SHORT,
  PIPELINE_KINDS,
  PIPELINE_PHASES,
  PIPELINE_PHASE_SET,
  readState,
  shortPhase,
  STEP_PHASES,
  TERMINAL_EXIT_TRANSITIONS,
  TERMINAL_PHASES,
  WORKTREE_REMOVED_PHASES,
  writeState,
  type PipelineState,
} from "./state";

let dir!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-state-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(
  slug: string,
  overrides: Partial<PipelineState> = {},
): PipelineState {
  return {
    slug,
    phase: "starting",
    repo: "/tmp/repo",
    updatedAt: "2026-04-30T12:00:00Z",
    ...overrides,
  };
}

describe("state", () => {
  it("writes and reads back a pipeline state file", () => {
    writeState(fixture("csv-export", { phase: "reviewing", pr: 142 }), dir);
    const got = readState("csv-export", dir);
    expect(got).not.toBeNull();
    expect(got?.phase).toBe("reviewing");
    expect(got?.pr).toBe(142);
  });

  it("returns null for a missing slug", () => {
    expect(readState("missing", dir)).toBeNull();
  });

  it("returns null for malformed json", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    expect(readState("bad", dir)).toBeNull();
  });

  it("readState returns null when state JSON is missing the phase field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "no-phase.json"),
      JSON.stringify({
        slug: "no-phase",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("no-phase", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type phase", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-phase.json"),
      JSON.stringify({
        slug: "bad-phase",
        phase: 42,
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("bad-phase", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type pr", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-pr.json"),
      JSON.stringify({
        slug: "bad-pr",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        pr: "not-a-number",
      }),
    );
    expect(readState("bad-pr", dir)).toBeNull();
  });

  it("readState returns null when state JSON has null for an optional field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "null-opt.json"),
      JSON.stringify({
        slug: "null-opt",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        autoMerge: null,
      }),
    );
    expect(readState("null-opt", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type worktree", () => {
    // f-coverage-2: optional `worktree` field had no wrong-type test
    // (asymmetric with `pr` and `autoMerge`).
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-worktree.json"),
      JSON.stringify({
        slug: "bad-worktree",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        worktree: 42,
      }),
    );
    expect(readState("bad-worktree", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type waitForCopilot (string instead of boolean)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-wait-for-copilot.json"),
      JSON.stringify({
        slug: "bad-wait-for-copilot",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        waitForCopilot: "true",
      }),
    );
    expect(readState("bad-wait-for-copilot", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type forceResearch (string instead of boolean)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-force-research.json"),
      JSON.stringify({
        slug: "bad-force-research",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        forceResearch: "yes",
      }),
    );
    expect(readState("bad-force-research", dir)).toBeNull();
  });

  it("readState accepts forceResearch: true and an absent forceResearch field", () => {
    writeState(fixture("force-research-on", { forceResearch: true }), dir);
    expect(readState("force-research-on", dir)?.forceResearch).toBe(true);

    fs.writeFileSync(
      path.join(dir, "force-research-absent.json"),
      JSON.stringify({
        slug: "force-research-absent",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("force-research-absent", dir)).not.toBeNull();
    expect(readState("force-research-absent", dir)).not.toHaveProperty(
      "forceResearch",
    );
  });

  it("readState accepts a well-formed epic membership and an absent epic field", () => {
    writeState(
      fixture("epic-member", {
        epic: { slug: "major-refactor", featureId: "f3" },
      }),
      dir,
    );
    expect(readState("epic-member", dir)?.epic).toEqual({
      slug: "major-refactor",
      featureId: "f3",
    });

    fs.writeFileSync(
      path.join(dir, "epic-absent.json"),
      JSON.stringify({
        slug: "epic-absent",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("epic-absent", dir)).not.toBeNull();
    expect(readState("epic-absent", dir)).not.toHaveProperty("epic");
  });

  it.each([
    ["missing featureId", { slug: "major-refactor" }],
    ["missing slug", { featureId: "f3" }],
    ["wrong-type slug", { slug: 3, featureId: "f3" }],
    ["not an object", "major-refactor/f3"],
  ] as const)(
    "readState returns null when the epic membership is malformed (%s)",
    (_label, epic) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "bad-epic.json"),
        JSON.stringify({
          slug: "bad-epic",
          phase: "reviewing",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          epic,
        }),
      );
      expect(readState("bad-epic", dir)).toBeNull();
    },
  );

  it.each(["auto", "always", "never"] as const)(
    "readState accepts copilotReview='%s'",
    (value) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `cr-${value}.json`),
        JSON.stringify({
          slug: `cr-${value}`,
          phase: "reviewing",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          copilotReview: value,
        }),
      );
      expect(readState(`cr-${value}`, dir)?.copilotReview).toBe(value);
    },
  );

  it("readState accepts an absent copilotReview field (absent ≡ auto)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cr-absent.json"),
      JSON.stringify({
        slug: "cr-absent",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("cr-absent", dir)).not.toBeNull();
    expect(readState("cr-absent", dir)).not.toHaveProperty("copilotReview");
  });

  it("readState returns null for an invalid copilotReview value (not a member)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cr-bad.json"),
      JSON.stringify({
        slug: "cr-bad",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        copilotReview: "sometimes",
      }),
    );
    expect(readState("cr-bad", dir)).toBeNull();
  });

  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "readState accepts effort='%s'",
    (value) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `effort-${value}.json`),
        JSON.stringify({
          slug: `effort-${value}`,
          phase: "reviewing",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          effort: value,
        }),
      );
      expect(readState(`effort-${value}`, dir)?.effort).toBe(value);
    },
  );

  it("readState accepts an absent effort field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "effort-absent.json"),
      JSON.stringify({
        slug: "effort-absent",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("effort-absent", dir)).not.toBeNull();
    expect(readState("effort-absent", dir)).not.toHaveProperty("effort");
  });

  it("readState returns null for an invalid effort value (not a member)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "effort-bad.json"),
      JSON.stringify({
        slug: "effort-bad",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        effort: "bogus",
      }),
    );
    expect(readState("effort-bad", dir)).toBeNull();
  });

  it.each(["opus", "haiku", "sonnet", "fable"] as const)(
    "readState accepts model='%s'",
    (value) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `model-${value}.json`),
        JSON.stringify({
          slug: `model-${value}`,
          phase: "reviewing",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          model: value,
        }),
      );
      expect(readState(`model-${value}`, dir)?.model).toBe(value);
    },
  );

  it("readState accepts an absent model field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "model-absent.json"),
      JSON.stringify({
        slug: "model-absent",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("model-absent", dir)).not.toBeNull();
    expect(readState("model-absent", dir)).not.toHaveProperty("model");
  });

  it("readState returns null for an invalid model value (not a member)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "model-bad.json"),
      JSON.stringify({
        slug: "model-bad",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        model: "gpt4",
      }),
    );
    expect(readState("model-bad", dir)).toBeNull();
  });

  it.each([...PHASE_MODEL_FIELDS])(
    "readState accepts a valid alias on per-phase field %s",
    (field) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `pm-${field}.json`),
        JSON.stringify({
          slug: `pm-${field}`,
          phase: "reviewing",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          [field]: "fable",
        }),
      );
      expect(
        (readState(`pm-${field}`, dir) as Record<string, unknown>)?.[field],
      ).toBe("fable");
    },
  );

  it.each([...PHASE_MODEL_FIELDS])(
    "readState returns null when per-phase field %s is out of enum",
    (field) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `pm-bad-${field}.json`),
        JSON.stringify({
          slug: `pm-bad-${field}`,
          phase: "reviewing",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          [field]: "gpt4",
        }),
      );
      expect(readState(`pm-bad-${field}`, dir)).toBeNull();
    },
  );

  it.each([
    ["slug", 42],
    ["repo", 99],
    ["updatedAt", false],
  ])(
    "readState returns null when required field %s has wrong type",
    (field, wrongValue) => {
      // f-coverage-4: of slug/phase/repo/updatedAt, only phase had a
      // wrong-type test. Mirror the phase test for the remaining three.
      fs.mkdirSync(dir, { recursive: true });
      const base: Record<string, unknown> = {
        slug: "ok-slug",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      };
      base[field] = wrongValue;
      fs.writeFileSync(
        path.join(dir, `bad-${field}.json`),
        JSON.stringify(base),
      );
      expect(readState(`bad-${field}`, dir)).toBeNull();
    },
  );

  it("readState returns null for a JSON array root", () => {
    // f-coverage-1: `typeof x !== 'object' || x === null || Array.isArray(x)`
    // has three guard branches. Cover the Array.isArray branch directly so
    // dropping it doesn't silently pass.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "array-root.json"),
      JSON.stringify(["slug", "phase", "repo", "updatedAt"]),
    );
    expect(readState("array-root", dir)).toBeNull();
  });

  it("readState returns null for a JSON null root", () => {
    // f-coverage-1: cover the `x === null` guard branch.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "null-root.json"), "null");
    expect(readState("null-root", dir)).toBeNull();
  });

  it("readState returns null for a JSON primitive root", () => {
    // f-coverage-1: cover the `typeof x !== 'object'` guard branch.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "primitive-root.json"),
      JSON.stringify("just-a-string"),
    );
    expect(readState("primitive-root", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type sessionId", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-sessionId.json"),
      JSON.stringify({
        slug: "bad-sessionId",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        sessionId: 42,
      }),
    );
    expect(readState("bad-sessionId", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type answer", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-answer.json"),
      JSON.stringify({
        slug: "bad-answer",
        phase: "triaged-no-change",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        answer: 42,
      }),
    );
    expect(readState("bad-answer", dir)).toBeNull();
  });

  it("readState accepts a string answer and an absent answer", () => {
    writeState(
      fixture("with-answer", {
        phase: "triaged-no-change",
        answer: "X works by Y.",
      }),
      dir,
    );
    expect(readState("with-answer", dir)?.answer).toBe("X works by Y.");

    fs.writeFileSync(
      path.join(dir, "answer-absent.json"),
      JSON.stringify({
        slug: "answer-absent",
        phase: "triaged-no-change",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("answer-absent", dir)).not.toBeNull();
    expect(readState("answer-absent", dir)).not.toHaveProperty("answer");
  });

  it("readState round-trips a full state with every optional field", () => {
    const full: PipelineState = {
      slug: "full",
      phase: "reviewing",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      pr: 142,
      worktree: "/tmp/worktree-full",
      autoMerge: false,
      waitForCopilot: true,
      forceResearch: true,
      copilotReview: "never",
      effort: "high",
      sessionId: "b034430c-03bd-4fa0-8393-9f0859800531",
      answer: "X works by Y.",
      gateOverride: { pr: 142, confirmedAt: "2026-05-17T00:05:00Z" },
    };
    writeState(full, dir);
    expect(readState("full", dir)).toEqual(full);
  });

  it("readState returns null when state JSON has wrong-type interview", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-interview.json"),
      JSON.stringify({
        slug: "bad-interview",
        phase: "triage-pending-interview",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        interview: 42,
      }),
    );
    expect(readState("bad-interview", dir)).toBeNull();
  });

  it("readState accepts a string interview digest and round-trips it", () => {
    writeState(
      fixture("with-interview", {
        phase: "triage-pending-interview",
        interview: "Q1: ... A: ...",
      }),
      dir,
    );
    expect(readState("with-interview", dir)?.interview).toBe("Q1: ... A: ...");
  });

  it("readState accepts interviewMode 'force' and 'skip', and rejects other values", () => {
    writeState(fixture("interview-force", { interviewMode: "force" }), dir);
    expect(readState("interview-force", dir)?.interviewMode).toBe("force");

    writeState(fixture("interview-skip", { interviewMode: "skip" }), dir);
    expect(readState("interview-skip", dir)?.interviewMode).toBe("skip");

    fs.writeFileSync(
      path.join(dir, "bad-interview-mode.json"),
      JSON.stringify({
        slug: "bad-interview-mode",
        phase: "triaging",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        interviewMode: "always",
      }),
    );
    expect(readState("bad-interview-mode", dir)).toBeNull();
  });

  it("readState returns null when state JSON has a malformed gateOverride", () => {
    // gateOverride must be { pr: number, confirmedAt: string }. A token
    // missing confirmedAt (or with a wrong-typed field) is rejected so a
    // corrupt token can never silently authorise a merge in flow-merge-guard.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-override.json"),
      JSON.stringify({
        slug: "bad-override",
        phase: "gating",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        gateOverride: { pr: 142 },
      }),
    );
    expect(readState("bad-override", dir)).toBeNull();
  });

  it("readState round-trips a valid phaseLog array through writeState", () => {
    const withLog: PipelineState = {
      slug: "phaselog",
      phase: "reviewing",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      phaseLog: [
        { phase: "planning", at: "2026-05-17T00:01:00Z" },
        {
          phase: "reviewing",
          outcome: "clean",
          at: "2026-05-17T00:02:00Z",
        },
      ],
    };
    writeState(withLog, dir);
    expect(readState("phaselog", dir)).toEqual(withLog);
  });

  it("readState accepts an absent phaseLog field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "phaselog-absent.json"),
      JSON.stringify({
        slug: "phaselog-absent",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    expect(readState("phaselog-absent", dir)).not.toBeNull();
    expect(readState("phaselog-absent", dir)).not.toHaveProperty("phaseLog");
  });

  it("readState returns null when phaseLog is a non-array", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "phaselog-non-array.json"),
      JSON.stringify({
        slug: "phaselog-non-array",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        phaseLog: { phase: "planning", at: "2026-05-17T00:01:00Z" },
      }),
    );
    expect(readState("phaselog-non-array", dir)).toBeNull();
  });

  it("readState returns null when a phaseLog element is missing phase or at", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "phaselog-bad-element.json"),
      JSON.stringify({
        slug: "phaselog-bad-element",
        phase: "reviewing",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        // first entry is fine; second is missing `at`.
        phaseLog: [
          { phase: "planning", at: "2026-05-17T00:01:00Z" },
          { phase: "reviewing" },
        ],
      }),
    );
    expect(readState("phaselog-bad-element", dir)).toBeNull();
  });

  it("readState round-trips a valid checkpoint record through writeState", () => {
    const withCheckpoint: PipelineState = {
      slug: "with-checkpoint",
      phase: "gating",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      checkpoint: {
        site: "gate",
        phase: "gating",
        armedAt: "2026-05-17T00:01:00Z",
      },
    };
    writeState(withCheckpoint, dir);
    expect(readState("with-checkpoint", dir)).toEqual(withCheckpoint);
  });

  it("readState accepts an absent checkpoint field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "checkpoint-absent.json"),
      JSON.stringify({
        slug: "checkpoint-absent",
        phase: "gating",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    const got = readState("checkpoint-absent", dir);
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("checkpoint");
  });

  it("readState returns null when the checkpoint record is malformed", () => {
    // checkpoint must be { site, phase, armedAt }. A record with an
    // unrecognised site (or a missing armedAt) makes readState reject the
    // WHOLE state file (returns null), degrading this pipeline to
    // state-missing on resume — callers must treat a null readState as
    // exactly that, not assume a corrupt checkpoint sub-record is isolated
    // from the rest of state.json.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "checkpoint-malformed.json"),
      JSON.stringify({
        slug: "checkpoint-malformed",
        phase: "gating",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        checkpoint: { site: "not-a-real-site", phase: "gating" },
      }),
    );
    expect(readState("checkpoint-malformed", dir)).toBeNull();
  });

  it("readState round-trips a valid reap record through writeState", () => {
    const withReap: PipelineState = {
      slug: "with-reap",
      phase: "merged",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      reap: {
        at: "2026-05-17T00:01:00Z",
        status: "ok",
        summary: "no live processes",
        ran: true,
      },
    };
    writeState(withReap, dir);
    expect(readState("with-reap", dir)).toEqual(withReap);
  });

  it("readState accepts an absent reap field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "reap-absent.json"),
      JSON.stringify({
        slug: "reap-absent",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    const got = readState("reap-absent", dir);
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("reap");
  });

  it("readState returns null when the reap record is malformed", () => {
    // reap must be { at, status, summary, ran, problems? }. A record with
    // an unrecognised status (or a missing summary) makes readState reject
    // the WHOLE state file (returns null), degrading this pipeline to
    // state-missing on resume — callers must treat a null readState as
    // exactly that, not assume a corrupt reap sub-record is isolated from
    // the rest of state.json.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "reap-malformed.json"),
      JSON.stringify({
        slug: "reap-malformed",
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        reap: { at: "2026-05-17T00:01:00Z", status: "not-a-real-status" },
      }),
    );
    expect(readState("reap-malformed", dir)).toBeNull();
  });

  it("readState round-trips a valid untracked list through writeState", () => {
    const withUntracked: PipelineState = {
      slug: "with-untracked",
      phase: "gated",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      untracked: [
        {
          id: 1,
          title: "found a dead code path",
          source: "pr-review",
          at: "2026-05-17T00:01:00Z",
        },
        {
          id: 2,
          title: "flaky test",
          body: "reproduce with -t flag",
          source: "verify",
          at: "2026-05-17T00:02:00Z",
          filedAs: "https://github.com/gavingolden/flow/issues/999",
          droppedAt: "2026-05-17T00:03:00Z",
        },
      ],
    };
    writeState(withUntracked, dir);
    expect(readState("with-untracked", dir)).toEqual(withUntracked);
  });

  it("readState accepts an absent untracked field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "untracked-absent.json"),
      JSON.stringify({
        slug: "untracked-absent",
        phase: "gated",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    const got = readState("untracked-absent", dir);
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("untracked");
  });

  it("readState returns null when untracked is not an array", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "untracked-not-array.json"),
      JSON.stringify({
        slug: "untracked-not-array",
        phase: "gated",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        untracked: { id: 1, title: "x", source: "y", at: "z" },
      }),
    );
    expect(readState("untracked-not-array", dir)).toBeNull();
  });

  it("readState returns null when an untracked entry is missing a required field", () => {
    for (const missing of ["id", "title", "source", "at"] as const) {
      const entry: Record<string, unknown> = {
        id: 1,
        title: "x",
        source: "y",
        at: "2026-05-17T00:00:00Z",
      };
      delete entry[missing];
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `untracked-missing-${missing}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          slug: `untracked-missing-${missing}`,
          phase: "gated",
          repo: "/tmp/repo",
          updatedAt: "2026-05-17T00:00:00Z",
          untracked: [entry],
        }),
      );
      expect(readState(`untracked-missing-${missing}`, dir)).toBeNull();
    }
  });

  it("readState returns null when an untracked entry has a wrong-typed field", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "untracked-wrong-type.json"),
      JSON.stringify({
        slug: "untracked-wrong-type",
        phase: "gated",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        untracked: [{ id: "1", title: "x", source: "y", at: "z" }],
      }),
    );
    expect(readState("untracked-wrong-type", dir)).toBeNull();
  });

  it("readState round-trips valid pid and procStartedAt through writeState", () => {
    const withLiveness: PipelineState = {
      slug: "with-liveness",
      phase: "starting",
      repo: "/tmp/repo",
      updatedAt: "2026-05-17T00:00:00Z",
      pid: 4242,
      procStartedAt: 1747440000,
    };
    writeState(withLiveness, dir);
    expect(readState("with-liveness", dir)).toEqual(withLiveness);
  });

  it("readState accepts absent pid and procStartedAt fields", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "liveness-absent.json"),
      JSON.stringify({
        slug: "liveness-absent",
        phase: "starting",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
      }),
    );
    const got = readState("liveness-absent", dir);
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("pid");
    expect(got).not.toHaveProperty("procStartedAt");
  });

  it("readState returns null when state JSON has wrong-type pid", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-pid.json"),
      JSON.stringify({
        slug: "bad-pid",
        phase: "starting",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        pid: "4242",
      }),
    );
    expect(readState("bad-pid", dir)).toBeNull();
  });

  it("readState returns null when state JSON has wrong-type procStartedAt", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-proc-started-at.json"),
      JSON.stringify({
        slug: "bad-proc-started-at",
        phase: "starting",
        repo: "/tmp/repo",
        updatedAt: "2026-05-17T00:00:00Z",
        procStartedAt: "1747440000",
      }),
    );
    expect(readState("bad-proc-started-at", dir)).toBeNull();
  });

  it("listStates skips off-shape JSON files alongside valid ones", () => {
    writeState(fixture("real"), dir);
    fs.writeFileSync(
      path.join(dir, "off-shape.json"),
      JSON.stringify({ random: "shape" }),
    );
    expect(listStates(dir).map((s) => s.slug)).toEqual(["real"]);
  });

  it("listStates returns every well-formed state file", () => {
    writeState(fixture("a"), dir);
    writeState(fixture("b", { phase: "merged" }), dir);
    writeState(fixture("c", { phase: "planning" }), dir);
    const all = listStates(dir)
      .map((s) => s.slug)
      .sort();
    expect(all).toEqual(["a", "b", "c"]);
  });

  it("listStates skips non-json files", () => {
    writeState(fixture("a"), dir);
    fs.writeFileSync(path.join(dir, "ignore.txt"), "irrelevant");
    expect(listStates(dir).map((s) => s.slug)).toEqual(["a"]);
  });

  it("listStates skips legacy <slug>.turn.json files", () => {
    writeState(fixture("real"), dir);
    fs.writeFileSync(
      path.join(dir, "legacy.turn.json"),
      JSON.stringify({
        slug: "legacy",
        turnId: "x",
        blockCount: 1,
        lastPhase: "verifying",
        lastStopAt: "x",
      }) + "\n",
    );
    expect(listStates(dir).map((s) => s.slug)).toEqual(["real"]);
  });

  it("listStates ignores turn-tracking files in the turns/ subdirectory", () => {
    // Regression guard for the phantom-pipeline bug: turn-tracking files
    // used to live at `<dir>/<slug>.turn.json` and `listStates`'s
    // `.endsWith('.json')` filter picked them up as state files whose
    // JSON.parse cast yielded `{ slug: '<slug>.turn', phase: undefined }`.
    // Moving them to a sibling `turns/` subdirectory keeps `listStates`
    // (which reads `dir` non-recursively) blind to them.
    writeState(fixture("real"), dir);
    fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "turns", "real.json"),
      JSON.stringify({
        slug: "real",
        turnId: "x",
        blockCount: 1,
        lastPhase: "verifying",
        lastStopAt: "x",
      }) + "\n",
    );
    expect(listStates(dir).map((s) => s.slug)).toEqual(["real"]);
  });

  it("listStates returns [] when directory is missing", () => {
    expect(listStates(path.join(dir, "nope"))).toEqual([]);
  });

  it("deleteState removes the file and returns true", () => {
    writeState(fixture("a"), dir);
    expect(deleteState("a", dir)).toBe(true);
    expect(readState("a", dir)).toBeNull();
  });

  it("deleteState returns false for missing slug", () => {
    expect(deleteState("missing", dir)).toBe(false);
  });
});

describe("isMainStateFile", () => {
  // Direct boundary coverage for the predicate `listStates` uses to filter
  // legacy `<slug>.X.json` turn-tracking files out of the state dir root.
  // The commit body promises rejection of "any other `<slug>.X.json`" shape,
  // not just `.turn.json` — this table documents that intent.
  it.each([
    ["real.json", true],
    ["a-b_c.json", true],
    ["legacy.turn.json", false],
    ["foo.bak.json", false],
    ["foo.tmp.json", false],
    ["foo.bar.json", false],
    [".json", false],
    ["foo", false],
    ["", false],
  ])("isMainStateFile(%j) === %s", (name, expected) => {
    expect(isMainStateFile(name)).toBe(expected);
  });
});

describe("phase constants", () => {
  it("TERMINAL_PHASES, PENDING_PHASES, STEP_PHASES are pairwise disjoint", () => {
    const pairs: Array<[readonly string[], readonly string[], string]> = [
      [TERMINAL_PHASES, PENDING_PHASES, "TERMINAL ∩ PENDING"],
      [TERMINAL_PHASES, STEP_PHASES, "TERMINAL ∩ STEP"],
      [PENDING_PHASES, STEP_PHASES, "PENDING ∩ STEP"],
    ];
    for (const [a, b, label] of pairs) {
      const overlap = a.filter((v) => b.includes(v));
      expect(overlap, label).toEqual([]);
    }
  });

  it("FINISHED_PHASES and AWAITING_HUMAN_PHASES together are exactly TERMINAL_PHASES (anti-drift guard: a future terminal phase must be explicitly classified into one of the two buckets)", () => {
    expect([...FINISHED_PHASES, ...AWAITING_HUMAN_PHASES].sort()).toEqual(
      [...TERMINAL_PHASES].sort(),
    );
  });

  it("FINISHED_PHASES and AWAITING_HUMAN_PHASES are disjoint", () => {
    const overlap = FINISHED_PHASES.filter((v) =>
      (AWAITING_HUMAN_PHASES as readonly string[]).includes(v),
    );
    expect(overlap).toEqual([]);
  });

  it("WORKTREE_REMOVED_PHASES is exactly FINISHED_PHASES minus 'epic-approved' (anti-drift guard: a new FINISHED_PHASES entry must be explicitly classified as worktree-removed or not)", () => {
    expect([...WORKTREE_REMOVED_PHASES].sort()).toEqual(
      FINISHED_PHASES.filter((p) => p !== "epic-approved").sort(),
    );
  });

  it("PIPELINE_PHASES is the union of TERMINAL, PENDING, STEP", () => {
    const expected = new Set([
      ...STEP_PHASES,
      ...PENDING_PHASES,
      ...TERMINAL_PHASES,
    ]);
    expect(new Set(PIPELINE_PHASES)).toEqual(expected);
  });

  it("PIPELINE_PHASE_SET membership matches PIPELINE_PHASES", () => {
    for (const p of PIPELINE_PHASES) {
      expect(PIPELINE_PHASE_SET.has(p)).toBe(true);
    }
    expect(PIPELINE_PHASE_SET.has("not-a-phase")).toBe(false);
  });

  it("includes the new pending-end phases for the Stop hook", () => {
    expect(PENDING_PHASES).toContain("triaged-no-change");
    expect(PENDING_PHASES).toContain("triage-pending-clarification");
    expect(PENDING_PHASES).toContain("approval-pending-clarification");
    expect(PENDING_PHASES).toContain("ci-wait-pending");
    expect(PENDING_PHASES).toContain("checkpoint-pending-clear");
  });

  it("includes the two intent-interview pending phases and their PHASE_SHORT entries", () => {
    expect(PENDING_PHASES).toContain("triage-pending-interview");
    expect(PENDING_PHASES).toContain("plan-pending-interview");
    expect(PHASE_SHORT["triage-pending-interview"]).toBe("intq?");
    expect(PHASE_SHORT["plan-pending-interview"]).toBe("planq?");
  });

  it("includes the full epic-designer phase lifecycle", () => {
    // /flow-epic-create's lifecycle: starting → epic-designing → epic-validating →
    // epic-pr-open → epic-design-pending-review → {epic-approved | cancelled}.
    // The three epic step phases live in STEP_PHASES; the review checkpoint is
    // a pending phase (so flow-stop-guard permits ending the turn there);
    // epic-approved is terminal (cancelled is reused for the cancel path).
    for (const p of ["epic-designing", "epic-validating", "epic-pr-open"]) {
      expect(STEP_PHASES as readonly string[]).toContain(p);
    }
    expect(PENDING_PHASES).toContain("epic-design-pending-review");
    expect(TERMINAL_PHASES).toContain("epic-approved");
    expect(isLegitimateEndPhase("epic-design-pending-review")).toBe(true);
    expect(isLegitimateEndPhase("epic-approved")).toBe(true);
    expect(isPipelinePhase("epic-designing")).toBe(true);
  });

  it("ci-wait-pending is a pending phase, disjoint from STEP and TERMINAL", () => {
    // The yielded counterpart to the active `ci-wait` step phase: the
    // supervisor legitimately ends its turn at ci-wait-pending while
    // flow-ci-wait runs force-backgrounded.
    expect(PENDING_PHASES).toContain("ci-wait-pending");
    expect(STEP_PHASES as readonly string[]).not.toContain("ci-wait-pending");
    expect(TERMINAL_PHASES as readonly string[]).not.toContain(
      "ci-wait-pending",
    );
    expect(isLegitimateEndPhase("ci-wait-pending")).toBe(true);
    expect(isPipelinePhase("ci-wait-pending")).toBe(true);
  });

  it("isPipelinePhase narrows known phases", () => {
    expect(isPipelinePhase("implementing")).toBe(true);
    expect(isPipelinePhase("merged")).toBe(true);
    expect(isPipelinePhase("plan-pending-review")).toBe(true);
    expect(isPipelinePhase("ci-wait-pending")).toBe(true);
    expect(isPipelinePhase("implmenting")).toBe(false);
    expect(isPipelinePhase("")).toBe(false);
  });

  it("isLegitimateEndPhase is true for terminal + pending only", () => {
    for (const p of TERMINAL_PHASES) expect(isLegitimateEndPhase(p)).toBe(true);
    for (const p of PENDING_PHASES) expect(isLegitimateEndPhase(p)).toBe(true);
    for (const p of STEP_PHASES) expect(isLegitimateEndPhase(p)).toBe(false);
  });

  it("EPIC_PHASES is exactly the known epic-designer phases, in order (drift-guard)", () => {
    // Exact equality, not containment — this is what catches a future
    // FEATURE phase adopting the "epic-" prefix by accident.
    expect(EPIC_PHASES).toEqual([
      "epic-designing",
      "epic-validating",
      "epic-pr-open",
      "epic-design-pending-review",
      "epic-approved",
    ]);
  });

  it("PIPELINE_KINDS is exactly the three supervisor kinds, and isPipelineKind agrees (drift-guard)", () => {
    // The literals live in state.ts once; `resolveKindFromPane` (tmux.ts) and
    // `parseResumeKind` (flow-session-start-hook.ts) both derive from
    // isPipelineKind rather than re-listing them. Exact equality here is what
    // makes adding a fourth kind a deliberate, test-breaking act instead of a
    // silent downgrade to "feature" at whichever validator was missed.
    expect(PIPELINE_KINDS).toEqual(["feature", "epic-design", "epic-run"]);
    for (const k of PIPELINE_KINDS) expect(isPipelineKind(k)).toBe(true);
    for (const notAKind of [
      "",
      "epic",
      "EPIC-RUN",
      "bogus",
      "epic-designing",
    ]) {
      expect(isPipelineKind(notAKind)).toBe(false);
    }
  });

  it("isEpicPhase narrows epic phases only", () => {
    expect(isEpicPhase("epic-designing")).toBe(true);
    expect(isEpicPhase("epic-design-pending-review")).toBe(true);
    expect(isEpicPhase("epic-approved")).toBe(true);
    expect(isEpicPhase("implementing")).toBe(false);
    expect(isEpicPhase("starting")).toBe(false);
  });

  it("autoResumesAfterClear defaults to the feature terminal/gated rule", () => {
    expect(autoResumesAfterClear("gated")).toBe(true);
    expect(autoResumesAfterClear("epic-design-pending-review")).toBe(true);
    expect(autoResumesAfterClear("implementing")).toBe(true);
    expect(autoResumesAfterClear("merged")).toBe(false);
    expect(autoResumesAfterClear("cancelled")).toBe(false);
    expect(autoResumesAfterClear("needs-human")).toBe(false);
    expect(autoResumesAfterClear("epic-approved")).toBe(false);
  });

  it("autoResumesAfterClear('epic-run', ...) resumes regardless of phase", () => {
    expect(autoResumesAfterClear("epic-approved", "epic-run")).toBe(true);
  });

  it("isAllowedTerminalExit allows the three documented gated exits", () => {
    expect(isAllowedTerminalExit("gated", "verifying")).toBe(true);
    expect(isAllowedTerminalExit("gated", "gating")).toBe(true);
    expect(isAllowedTerminalExit("gated", "merging")).toBe(true);
  });

  it("isAllowedTerminalExit rejects everything else, including a non-terminal from-phase", () => {
    expect(isAllowedTerminalExit("gated", "triaging")).toBe(false);
    expect(isAllowedTerminalExit("merged", "verifying")).toBe(false);
    expect(isAllowedTerminalExit("verifying", "gating")).toBe(false);
  });

  it("isAllowedTerminalExit returns false (not a throw) for Object.prototype keys", () => {
    expect(isAllowedTerminalExit("constructor", "verifying")).toBe(false);
    expect(isAllowedTerminalExit("__proto__", "verifying")).toBe(false);
  });

  it("TERMINAL_EXIT_TRANSITIONS is exactly {gated: [verifying, gating, merging]} (drift-guard)", () => {
    // Exact equality, not containment — this is what catches a silent
    // widening of the allowlist to a phase other than `gated`, or a
    // silent addition/removal of one of the three documented targets.
    expect(Object.keys(TERMINAL_EXIT_TRANSITIONS)).toEqual(["gated"]);
    expect(TERMINAL_EXIT_TRANSITIONS.gated).toEqual([
      "verifying",
      "gating",
      "merging",
    ]);
  });

  it("every TERMINAL_EXIT_TRANSITIONS.gated target is a real, non-terminal phase", () => {
    for (const target of TERMINAL_EXIT_TRANSITIONS.gated) {
      expect(PIPELINE_PHASES as readonly string[]).toContain(target);
      expect(TERMINAL_PHASES as readonly string[]).not.toContain(target);
    }
  });
});

describe("shortPhase", () => {
  // The canonical abbreviation for every pipeline phase, restated here
  // independently of PHASE_SHORT so a typo in the source map is caught rather
  // than silently mirrored. This is the published `@flow-phase-short` vocabulary.
  const EXPECTED: Record<string, string> = {
    starting: "start",
    triaging: "triage",
    "worktree-create": "wktree",
    planning: "plan",
    implementing: "impl",
    "installing-skills": "skills",
    verifying: "verify",
    "ci-wait": "ci",
    reviewing: "review",
    gating: "gate",
    merging: "merge",
    "plan-pending-review": "plan?",
    "triaged-no-change": "no-chg",
    "triage-pending-clarification": "triage?",
    "triage-pending-interview": "intq?",
    "approval-pending-clarification": "appr?",
    "ci-wait-pending": "ci?",
    "checkpoint-pending-clear": "ckpt?",
    merged: "merged",
    gated: "gated",
    "needs-human": "human",
    cancelled: "cancel",
    "epic-designing": "e-dsgn",
    "epic-validating": "e-val",
    "epic-pr-open": "e-pr",
    "epic-design-pending-review": "e-rvw?",
    "epic-approved": "e-ok",
    "plan-pending-interview": "planq?",
  };

  it.each(PIPELINE_PHASES)("maps %s to its canonical abbreviation", (phase) => {
    expect(shortPhase(phase)).toBe(EXPECTED[phase]);
  });

  it("falls through to the raw string for an unknown/future phase", () => {
    expect(shortPhase("future-phase")).toBe("future-phase");
    expect(shortPhase("")).toBe("");
  });

  it("has an explicit PHASE_SHORT entry for every pipeline phase (drift-guard)", () => {
    // A phase added to PIPELINE_PHASES without an abbreviation must fail CI
    // here (alongside the compile-time Record<PipelinePhase, string>
    // completeness check), so @flow-phase-short never silently falls through
    // to a raw string for a known phase.
    for (const phase of PIPELINE_PHASES) {
      expect(
        Object.prototype.hasOwnProperty.call(PHASE_SHORT, phase),
        `PHASE_SHORT missing entry for '${phase}'`,
      ).toBe(true);
    }
  });

  it("has no PHASE_SHORT entries beyond PIPELINE_PHASES (no stale abbreviations)", () => {
    const known = new Set<string>(PIPELINE_PHASES);
    for (const key of Object.keys(PHASE_SHORT)) {
      expect(known.has(key), `PHASE_SHORT has stale entry '${key}'`).toBe(true);
    }
  });
});
