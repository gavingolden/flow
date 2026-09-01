import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseArgs,
  render,
  run,
  buildCommentBody,
  findMarkedCommentId,
  postSnapshotComment,
  SNAPSHOT_MARKER,
  type GhRunner,
} from "./flow-pipeline-summary";
import { renderComment } from "./lib/pipeline-summary-sources";
import { writeState, type PipelineState } from "./lib/state";
import type { ReadConfigFile } from "./lib/modules-config";

// `run()` always resolves lens via `resolveLens(flag, read)`; passing this
// injected reader (rather than leaving `read` undefined, which falls
// through to the REAL `~/.flow/config.json`) pins every pre-existing test
// below to the `dev` shape it was written against — a developer's local
// `output.lens: "dev"` config must never redden this suite either way.
const DEV_LENS_READ: ReadConfigFile = () => ({ output: { lens: "dev" } });

let tmpRoot!: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pipeline-summary-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content);
  return p;
}

// The byte-exact stop-guard sentinels this block must NEVER emit as its
// last line — flow-gate-summary owns them.
function lastNonEmptyLine(rendered: string): string {
  return (
    rendered
      .split("\n")
      .filter((l) => l !== "")
      .pop() ?? ""
  );
}

const EMPTY_RENDER = {
  prChangesRaw: "",
  phaseLog: null,
  prReviewRaw: "",
  fixApplierRaw: "",
  consolidatorRaw: "",
  ciWaitRaw: "",
  filedIssuesRaw: "",
  fixApplierForIssues: "",
  manualStepsBlock: "",
};

describe("parseArgs", () => {
  it("requires --status", () => {
    expect(parseArgs([])).toEqual({ error: "--status is required" });
  });

  it("rejects an invalid --status", () => {
    const r = parseArgs(["--status", "cancelled"]);
    expect("error" in r && r.error).toContain("--status must be one of");
  });

  it("rejects a flag whose value is the next flag", () => {
    expect(parseArgs(["--status", "--state-file"])).toEqual({
      error: "--status requires a value",
    });
  });

  it("parses the full flag surface", () => {
    expect(
      parseArgs([
        "--status",
        "merged",
        "--state-file",
        "/s.json",
        "--pr-changes-file",
        "/c.json",
      ]),
    ).toEqual({
      status: "merged",
      stateFile: "/s.json",
      prChangesFile: "/c.json",
    });
  });

  it("parses --intent-resolution", () => {
    const r = parseArgs([
      "--status",
      "merged",
      "--intent-resolution",
      "/i.json",
    ]);
    expect(r).toMatchObject({ intentResolutionFile: "/i.json" });
  });

  it("parses the five echo-prose flags", () => {
    expect(
      parseArgs([
        "--status",
        "merged",
        "--echo-prose",
        "--pr-url",
        "https://github.com/org/repo/pull/7",
        "--plan-file",
        "/w/.flow-tmp/plan.md",
        "--pr-title",
        "Add recap",
        "--branch",
        "feat/recap",
      ]),
    ).toEqual({
      status: "merged",
      echoProse: true,
      prUrl: "https://github.com/org/repo/pull/7",
      planFile: "/w/.flow-tmp/plan.md",
      prTitle: "Add recap",
      branch: "feat/recap",
    });
  });

  it("treats --echo-prose as a valueless boolean flag", () => {
    const r = parseArgs(["--status", "gated", "--echo-prose"]);
    expect(r).toEqual({ status: "gated", echoProse: true });
  });
});

describe("render — explicit none discipline", () => {
  it("prints all seven sections with `none` when every source is empty", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("## PIPELINE SNAPSHOT");
    for (const header of [
      "CHANGES:",
      "PHASES:",
      "INTENT:",
      "FINDINGS:",
      "FORECLOSED PATHS:",
      "FOLLOW-UP ISSUES:",
      "MANUAL STEPS:",
    ]) {
      const idx = out.indexOf(header);
      expect(idx, `${header} present`).toBeGreaterThanOrEqual(0);
      // The line after each header (indented) is `none`.
      expect(out).toContain(`${header}\n  none`);
    }
  });

  it("never emits a stop-guard sentinel as the last line", () => {
    const out = render(EMPTY_RENDER);
    const last = lastNonEmptyLine(out);
    expect(last).not.toBe("MERGED");
    expect(last).not.toBe("cancelled");
    expect(last.startsWith("GATED:")).toBe(false);
    expect(last.startsWith("NEEDS HUMAN:")).toBe(false);
  });
});

describe("render — CHANGES", () => {
  it("renders a commits/diff line when sourced", () => {
    const out = render({
      ...EMPTY_RENDER,
      prChangesRaw: JSON.stringify({
        additions: 40,
        deletions: 7,
        changedFiles: 5,
        commits: 3,
      }),
    });
    expect(out).toContain("3 commits, +40/-7 across 5 files");
  });

  it("degrades malformed pr-changes JSON to (unreadable)", () => {
    const out = render({ ...EMPTY_RENDER, prChangesRaw: "{not json" });
    expect(out).toContain("CHANGES:\n  (unreadable)");
  });
});

describe("render — PHASES", () => {
  it("renders phaseLog entries in order with outcomes", () => {
    const out = render({
      ...EMPTY_RENDER,
      phaseLog: [
        { phase: "planning", at: "t1" },
        { phase: "reviewing", outcome: "clean", at: "t2" },
      ],
    });
    const phasesIdx = out.indexOf("PHASES:");
    const planningIdx = out.indexOf("planning", phasesIdx);
    const reviewingIdx = out.indexOf("reviewing -> clean", phasesIdx);
    expect(planningIdx).toBeGreaterThan(phasesIdx);
    expect(reviewingIdx).toBeGreaterThan(planningIdx);
  });

  it("prints `PHASES: none` for an absent phaseLog", () => {
    const out = render({ ...EMPTY_RENDER, phaseLog: null });
    expect(out).toContain("PHASES:\n  none");
  });
});

describe("render — INTENT", () => {
  it("prints `INTENT: none` when the artifact is absent", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("INTENT:\n  none");
  });

  it("renders the verdict + resolution line when present", () => {
    const out = render({
      ...EMPTY_RENDER,
      intentResolutionRaw: JSON.stringify({
        verdict: "scope-drift",
        guessed_purpose: "Refactors the logger.",
        resolution:
          "Guess names only a logger refactor; PR also adds a new endpoint.",
        cross_model: { ran: false, agreement: null },
      }),
    });
    expect(out).toContain(
      "INTENT:\n  scope-drift: Guess names only a logger refactor; PR also adds a new endpoint.",
    );
  });

  it("appends a cross-model agreement line when present", () => {
    const out = render({
      ...EMPTY_RENDER,
      intentResolutionRaw: JSON.stringify({
        verdict: "fundamental",
        guessed_purpose: "x",
        resolution: "y",
        cross_model: { ran: true, agreement: "agree" },
      }),
    });
    expect(out).toContain("cross-model: agree");
  });

  it("degrades a shape-invalid intent-resolution artifact to (unreadable)", () => {
    const out = render({
      ...EMPTY_RENDER,
      intentResolutionRaw: JSON.stringify({ foo: 1 }),
    });
    expect(out).toContain("INTENT:\n  (unreadable)");
  });

  it("degrades unparseable JSON to (unreadable)", () => {
    const out = render({ ...EMPTY_RENDER, intentResolutionRaw: "{not json" });
    expect(out).toContain("INTENT:\n  (unreadable)");
  });

  it("renders '<verdict>: (resolution unreadable)' when only verdict is readable", () => {
    const out = render({
      ...EMPTY_RENDER,
      intentResolutionRaw: JSON.stringify({ verdict: "scope-drift" }),
    });
    expect(out).toContain("INTENT:\n  scope-drift: (resolution unreadable)");
  });

  it("renders '(verdict unreadable): <resolution>' when only resolution is readable", () => {
    const out = render({
      ...EMPTY_RENDER,
      intentResolutionRaw: JSON.stringify({
        resolution: "guess is narrower than the request",
      }),
    });
    expect(out).toContain(
      "INTENT:\n  (verdict unreadable): guess is narrower than the request",
    );
  });

  it("still appends cross-model when only one primary field rendered", () => {
    const out = render({
      ...EMPTY_RENDER,
      intentResolutionRaw: JSON.stringify({
        verdict: "fundamental",
        cross_model: { ran: true, agreement: "agree" },
      }),
    });
    expect(out).toContain(
      "INTENT:\n  fundamental: (resolution unreadable)\n  cross-model: agree",
    );
  });
});

describe("render — FINDINGS", () => {
  it("summarizes review verdict + fix-applier + consolidator + CI/Copilot", () => {
    const out = render({
      ...EMPTY_RENDER,
      prReviewRaw: JSON.stringify({
        status: "partial",
        completed_steps: [],
        missed_steps: ["x"],
        escalation_tag: null,
        summary: "two findings open",
      }),
      fixApplierRaw: JSON.stringify({
        commits: [
          {
            sha: "a",
            files: ["f"],
            finding_id: "F1",
            reasoning: "r",
            verify_status: "pass",
          },
        ],
        deferred: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "one fix",
      }),
      consolidatorRaw: JSON.stringify({
        consolidated_findings: [],
        dropped_by_validation: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "ok",
      }),
      ciWaitRaw: JSON.stringify({
        decision: "proceed-to-review",
        copilotConfigured: true,
        copilotSkipReason: null,
      }),
    });
    expect(out).toContain("review: partial — two findings open");
    expect(out).toContain("fixes: 1 fixed in-cycle, 0 deferred");
    expect(out).toContain("consolidator: 0 findings, 0 dropped");
    expect(out).toContain("CI: proceed-to-review");
    expect(out).toContain("Copilot: reviewed");
  });

  it("renders `Copilot: not configured` when copilotConfigured is false", () => {
    const out = render({
      ...EMPTY_RENDER,
      ciWaitRaw: JSON.stringify({
        decision: "proceed-to-review-no-bot",
        copilotConfigured: false,
      }),
    });
    expect(out).toContain("Copilot: not configured");
  });

  it("renders `Copilot: skipped (<reason>)` when a skip reason is present", () => {
    const out = render({
      ...EMPTY_RENDER,
      ciWaitRaw: JSON.stringify({
        decision: "proceed-to-review-no-bot",
        copilotConfigured: true,
        copilotSkipReason: "unclaimed-after-deadline",
      }),
    });
    expect(out).toContain("Copilot: skipped (unclaimed-after-deadline)");
  });

  it("degrades a malformed pr-review artifact to (unreadable)", () => {
    const out = render({
      ...EMPTY_RENDER,
      prReviewRaw: JSON.stringify({ status: "not-a-status" }),
    });
    expect(out).toContain("review: (unreadable)");
  });

  it("degrades a malformed fix-applier artifact to (unreadable)", () => {
    const out = render({ ...EMPTY_RENDER, fixApplierRaw: "{not json" });
    expect(out).toContain("fixes: (unreadable)");
  });

  it("degrades a malformed consolidator artifact to (unreadable)", () => {
    const out = render({ ...EMPTY_RENDER, consolidatorRaw: "{}" });
    expect(out).toContain("consolidator: (unreadable)");
  });

  it("degrades a malformed ci-wait-result.json to CI: (unreadable)", () => {
    const out = render({ ...EMPTY_RENDER, ciWaitRaw: "{not json" });
    expect(out).toContain("CI: (unreadable)");
  });

  it("renders `FINDINGS: none` when no findings artifacts present", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("FINDINGS:\n  none");
  });
});

describe("render — FORECLOSED PATHS", () => {
  const fixApplierWithProse = JSON.stringify({
    commits: [],
    deferred: [],
    rejected_alternatives: [
      {
        finding_id: "F1",
        considered_approach: "memoize the parser",
        why_rejected: "cache-invalidation complexity",
      },
    ],
    anti_patterns_found: [],
    summary: "s",
  });
  const consolidatorWithProse = JSON.stringify({
    consolidated_findings: [],
    dropped_by_validation: [],
    rejected_alternatives: ["kept the two lenses separate"],
    anti_patterns_found: [],
    summary: "s",
  });

  it("renders a FORECLOSED PATHS section after FINDINGS", () => {
    const out = render(EMPTY_RENDER);
    const findingsIdx = out.indexOf("FINDINGS:");
    const foreclosedIdx = out.indexOf("FORECLOSED PATHS:");
    const followupIdx = out.indexOf("FOLLOW-UP ISSUES:");
    expect(foreclosedIdx).toBeGreaterThan(findingsIdx);
    expect(followupIdx).toBeGreaterThan(foreclosedIdx);
  });

  it("surfaces fix-applier + consolidator prose when present", () => {
    const out = render({
      ...EMPTY_RENDER,
      fixApplierRaw: fixApplierWithProse,
      consolidatorRaw: consolidatorWithProse,
    });
    expect(out).toContain("memoize the parser");
    expect(out).toContain("kept the two lenses separate");
  });

  it("renders `FORECLOSED PATHS: none` when both sources empty", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("FORECLOSED PATHS:\n  none");
  });

  it("still renders the block (exit 0, no crash) for a malformed fix-applier artifact", () => {
    const out = render({
      ...EMPTY_RENDER,
      fixApplierRaw: "{not json",
      consolidatorRaw: consolidatorWithProse,
    });
    expect(out).toContain("FORECLOSED PATHS:");
    expect(out).toContain("fix-applier: (unreadable)");
    expect(out).toContain("kept the two lenses separate");
  });

  it("co-exists with the FINDINGS count line (not regressed)", () => {
    const out = render({
      ...EMPTY_RENDER,
      fixApplierRaw: fixApplierWithProse,
      consolidatorRaw: consolidatorWithProse,
    });
    // FINDINGS still summarizes counts; FORECLOSED PATHS carries the prose.
    expect(out).toContain(
      "fixes: 0 fixed in-cycle, 0 deferred, 0 anti-patterns noted",
    );
    expect(out).toContain("consolidator: 0 findings, 0 dropped");
    expect(out).toContain("memoize the parser");
  });

  it("is not the last non-empty line (sentinel-safety)", () => {
    const out = render({
      ...EMPTY_RENDER,
      fixApplierRaw: fixApplierWithProse,
    });
    const last = lastNonEmptyLine(out);
    expect(last).not.toBe("MERGED");
    expect(last.startsWith("GATED:")).toBe(false);
    // MANUAL STEPS is below FORECLOSED PATHS, so the foreclosed prose is never last.
    expect(out.indexOf("MANUAL STEPS:")).toBeGreaterThan(
      out.indexOf("FORECLOSED PATHS:"),
    );
  });
});

describe("render — FOLLOW-UP ISSUES", () => {
  it("lists filed URLs, unfiled warnings, and pr-review deferrals", () => {
    const out = render({
      ...EMPTY_RENDER,
      // The step-10 sweep's canonical format: `filed\t<url>` + `unfiled\t<title>`.
      filedIssuesRaw:
        "filed\thttps://github.com/o/r/issues/1\nunfiled\tFix the thing",
      fixApplierForIssues: JSON.stringify({
        commits: [],
        deferred: [
          {
            finding_id: "F2",
            tracker_entry_url: "https://github.com/o/r/issues/2",
            reason: "later",
          },
          { finding_id: "F3", tracker_entry_url: "", reason: "no tracker" },
        ],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "s",
      }),
    });
    expect(out).toContain("filed: https://github.com/o/r/issues/1");
    expect(out).toContain("sweep failed (unfiled): Fix the thing");
    expect(out).toContain(
      "pr-review deferral: https://github.com/o/r/issues/2",
    );
    expect(out).toContain("deferred (unfiled): no tracker");
  });

  it("also accepts a bare http line as filed (resume / hand-authored)", () => {
    const out = render({
      ...EMPTY_RENDER,
      filedIssuesRaw: "https://github.com/o/r/issues/9",
    });
    expect(out).toContain("filed: https://github.com/o/r/issues/9");
  });

  it("renders `FOLLOW-UP ISSUES: none` when nothing filed or deferred", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("FOLLOW-UP ISSUES:\n  none");
  });
});

describe("render — MANUAL STEPS", () => {
  it("embeds the captured followups block verbatim (preserves ran/failed)", () => {
    const block =
      "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow install --upgrade  (exit 0)";
    const out = render({ ...EMPTY_RENDER, manualStepsBlock: block });
    expect(out).toContain("LOCAL FOLLOW-UPS: 1 ran");
    expect(out).toContain("RAN     flow install --upgrade  (exit 0)");
  });

  it("renders `MANUAL STEPS: none` for an empty block", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("MANUAL STEPS:\n  none");
  });
});

describe("render — DEVIATIONS (dev lens)", () => {
  it("dev lens (explicit) still carries all seven today's-shape sections, plus a trailing DEVIATIONS", () => {
    const out = render({ ...EMPTY_RENDER, lens: "dev" });
    for (const header of [
      "CHANGES:",
      "PHASES:",
      "INTENT:",
      "FINDINGS:",
      "FORECLOSED PATHS:",
      "FOLLOW-UP ISSUES:",
      "MANUAL STEPS:",
      "DEVIATIONS:",
    ]) {
      expect(out).toContain(header);
    }
    expect(out).toContain("DEVIATIONS:\n  none");
  });

  it("omitted lens reproduces the explicit-dev shape byte-for-byte", () => {
    expect(render(EMPTY_RENDER)).toBe(render({ ...EMPTY_RENDER, lens: "dev" }));
  });
});

describe("render — pm lens", () => {
  it("has exactly CHANGES / REVIEW / DEVIATIONS / UNTRACKED / MANUAL STEPS — no PHASES, no FORECLOSED PATHS, no INTENT, no FINDINGS", () => {
    const out = render({ ...EMPTY_RENDER, lens: "pm" });
    for (const header of [
      "CHANGES:",
      "REVIEW:",
      "DEVIATIONS:",
      "UNTRACKED:",
      "MANUAL STEPS:",
    ]) {
      expect(out).toContain(header);
    }
    for (const header of [
      "PHASES:",
      "FORECLOSED PATHS:",
      "INTENT:",
      "FINDINGS:",
      "FOLLOW-UP ISSUES:",
    ]) {
      expect(out).not.toContain(header);
    }
  });

  it("REVIEW is the counts line, never the review: narrative field", () => {
    const out = render({
      ...EMPTY_RENDER,
      lens: "pm",
      prReviewRaw: JSON.stringify({
        status: "partial",
        completed_steps: [],
        missed_steps: ["x"],
        escalation_tag: null,
        summary: "two findings open",
      }),
    });
    expect(out).toContain("REVIEW:\n  partial — 0 findings fixed, 0 deferred");
    expect(out).not.toContain("review: partial — two findings open");
  });

  it("DEVIATIONS surfaces scoutRaw PLAN-DEVIATION bullets", () => {
    const out = render({
      ...EMPTY_RENDER,
      lens: "pm",
      scoutRaw: "## open_questions\n\n- PLAN-DEVIATION: renamed the export.\n",
    });
    expect(out).toContain("DEVIATIONS:\n  renamed the export.");
  });

  it("UNTRACKED renders the pre-rendered untrackedBlock lines, `none` when absent", () => {
    const withItems = render({
      ...EMPTY_RENDER,
      lens: "pm",
      untrackedBlock: "- #1 found a bug",
    });
    expect(withItems).toContain("UNTRACKED:\n  - #1 found a bug");
    const empty = render({ ...EMPTY_RENDER, lens: "pm" });
    expect(empty).toContain("UNTRACKED:\n  none");
  });
});

describe("run — end-to-end", () => {
  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  }

  it("--lens pm renders the pm shape end-to-end; no PHASES section", () => {
    const out = captureStdout(() => {
      const code = run(["--status", "merged", "--lens", "pm"]);
      expect(code).toBe(0);
    });
    expect(out).toContain("REVIEW:");
    expect(out).not.toContain("PHASES:");
  });

  it("--lens flag beats an injected config value", () => {
    const out = captureStdout(() => {
      run(["--status", "merged", "--lens", "dev"], {
        read: () => ({ output: { lens: "pm" } }),
      });
    });
    expect(out).toContain("PHASES:");
  });

  it("config-driven lens (no --lens flag) resolves via the injected read seam", () => {
    const out = captureStdout(() => {
      run(["--status", "merged"], {
        read: () => ({ output: { lens: "dev" } }),
      });
    });
    expect(out).toContain("PHASES:");
  });

  it("absent --lens and nothing recorded in config resolves the CLI to pm", () => {
    // render()'s own default is `dev` (test-pin stability), but run() must
    // resolve flag > config > "pm" — with both flag and config absent, the
    // CLI-observable output must be the pm shape (no PHASES section),
    // proving the CLI default diverges from the pure renderer's default.
    const out = captureStdout(() => {
      const code = run(["--status", "merged"], { read: () => ({}) });
      expect(code).toBe(0);
    });
    expect(out).toContain("REVIEW:");
    expect(out).not.toContain("PHASES:");
  });

  it("--scout-file threads PLAN-DEVIATION bullets into DEVIATIONS", () => {
    const scoutFile = write(
      "scout.md",
      "## open_questions\n\n- PLAN-DEVIATION: renderComment lives in sources.ts.\n",
    );
    const out = captureStdout(() => {
      run(["--status", "merged", "--lens", "pm", "--scout-file", scoutFile]);
    });
    expect(out).toContain("renderComment lives in sources.ts.");
  });

  it("an absent --scout-file degrades DEVIATIONS to none, not (unreadable)", () => {
    const out = captureStdout(() => {
      run([
        "--status",
        "merged",
        "--lens",
        "pm",
        "--scout-file",
        path.join(tmpRoot, "missing-scout.md"),
      ]);
    });
    expect(out).toContain("DEVIATIONS:\n  none");
    expect(out).not.toContain("(unreadable)");
  });

  it("--untracked-file threads pre-rendered lines into UNTRACKED", () => {
    const untrackedFile = write("untracked.md", "- #1 found a bug\n");
    const out = captureStdout(() => {
      run([
        "--status",
        "merged",
        "--lens",
        "pm",
        "--untracked-file",
        untrackedFile,
      ]);
    });
    expect(out).toContain("- #1 found a bug");
  });

  it("--counts-line prints ONLY the composed count line and exits 0", () => {
    const fixApplierFile = write(
      "fix-applier-result.json",
      JSON.stringify({
        commits: [
          {
            sha: "a",
            files: ["x"],
            finding_id: "F1",
            reasoning: "r",
            verify_status: "pass",
          },
        ],
        deferred: [
          { finding_id: "F2", tracker_entry_url: "", reason: "later" },
        ],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "s",
      }),
    );
    let code = -1;
    const out = captureStdout(() => {
      code = run([
        "--status",
        "merged",
        "--fix-applier-result",
        fixApplierFile,
        "--counts-line",
      ]);
    });
    expect(code).toBe(0);
    expect(out).toBe("1 findings fixed, 1 deferred\n");
  });

  it("reads a state-file phaseLog and renders PHASES in order", () => {
    const state: PipelineState = {
      slug: "demo",
      phase: "merged",
      repo: "/tmp/repo",
      updatedAt: "t",
      phaseLog: [
        { phase: "planning", at: "t1" },
        { phase: "merging", outcome: "squashed", at: "t2" },
      ],
    };
    writeState(state, tmpRoot);
    const out = captureStdout(() => {
      const code = run(
        ["--status", "merged", "--state-file", path.join(tmpRoot, "demo.json")],
        { read: DEV_LENS_READ },
      );
      expect(code).toBe(0);
    });
    expect(out).toContain("## PIPELINE SNAPSHOT");
    const planningIdx = out.indexOf("planning");
    const mergingIdx = out.indexOf("merging -> squashed");
    expect(planningIdx).toBeGreaterThan(0);
    expect(mergingIdx).toBeGreaterThan(planningIdx);
    expect(lastNonEmptyLine(out)).not.toBe("MERGED");
  });

  it("renders `PHASES: none` when the state file is absent", () => {
    const out = captureStdout(() => {
      run(
        [
          "--status",
          "needs-human",
          "--state-file",
          path.join(tmpRoot, "missing.json"),
        ],
        { read: DEV_LENS_READ },
      );
    });
    expect(out).toContain("PHASES:\n  none");
  });

  it("the --followups-block-file pass-through preserves the captured text", () => {
    const blockFile = write(
      "followups-block.txt",
      "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow install --upgrade  (exit 0)\n",
    );
    const out = captureStdout(() => {
      run(["--status", "merged", "--followups-block-file", blockFile], {
        read: DEV_LENS_READ,
      });
    });
    expect(out).toContain("RAN     flow install --upgrade  (exit 0)");
  });

  it("reads --intent-resolution and renders the INTENT section end-to-end", () => {
    const intentFile = write(
      "intent-resolution.json",
      JSON.stringify({
        verdict: "scope-drift",
        guessed_purpose: "x",
        resolution: "guess is narrower than the request",
        cross_model: { ran: false, agreement: null },
      }),
    );
    const out = captureStdout(() => {
      run(["--status", "gated", "--intent-resolution", intentFile], {
        read: DEV_LENS_READ,
      });
    });
    expect(out).toContain(
      "INTENT:\n  scope-drift: guess is narrower than the request",
    );
  });

  it("reads a verdict-only --intent-resolution artifact and renders the partial line end-to-end", () => {
    const intentFile = write(
      "intent-resolution-partial.json",
      JSON.stringify({ verdict: "benign-divergence" }),
    );
    const out = captureStdout(() => {
      run(["--status", "gated", "--intent-resolution", intentFile], {
        read: DEV_LENS_READ,
      });
    });
    expect(out).toContain(
      "INTENT:\n  benign-divergence: (resolution unreadable)",
    );
  });

  it("renders the --followups-jsonl note-only verdict (never re-executing entries)", () => {
    const jsonl = write(
      "local-followups.jsonl",
      JSON.stringify({
        id: "abc123",
        command: "flow install --upgrade",
        reason: "new helper landed",
        auto: true,
        registeredAt: "t1",
      }) + "\n",
    );
    const out = captureStdout(() => {
      run(["--status", "gated", "--followups-jsonl", jsonl], {
        read: DEV_LENS_READ,
      });
    });
    // noteOnly: true => the auto-allowlisted entry is NOTED, not run, and the
    // header carries the deferred verdict.
    expect(out).toContain("LOCAL FOLLOW-UPS (deferred — PR not yet merged)");
    expect(out).toContain("flow install --upgrade");
    expect(out).not.toContain("RAN     flow install --upgrade");
  });

  it("prefers --followups-block-file over --followups-jsonl when both are passed", () => {
    const blockFile = write(
      "followups-block.txt",
      "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow install --upgrade  (exit 0)\n",
    );
    const jsonl = write(
      "local-followups.jsonl",
      JSON.stringify({
        id: "abc123",
        command: "flow install --upgrade",
        reason: "new helper landed",
        auto: true,
        registeredAt: "t1",
      }) + "\n",
    );
    const out = captureStdout(() => {
      run(
        [
          "--status",
          "merged",
          "--followups-block-file",
          blockFile,
          "--followups-jsonl",
          jsonl,
        ],
        { read: DEV_LENS_READ },
      );
    });
    // Block-file wins: the captured ran/failed results are preserved and the
    // jsonl note-only fallback never fires.
    expect(out).toContain("RAN     flow install --upgrade  (exit 0)");
    expect(out).not.toContain(
      "LOCAL FOLLOW-UPS (deferred — PR not yet merged)",
    );
  });

  it("--echo-prose leads stdout with the delimited recap above the snapshot", () => {
    const out = captureStdout(() => {
      const code = run(
        [
          "--status",
          "merged",
          "--echo-prose",
          "--pr-url",
          "https://github.com/org/repo/pull/9",
          "--plan-file",
          "/w/.flow-tmp/plan.md",
          "--pr-title",
          "Echo recap",
          "--branch",
          "feat/echo",
        ],
        { read: DEV_LENS_READ },
      );
      expect(code).toBe(0);
    });
    expect(out.startsWith("<!-- flow-echo-recap:start -->")).toBe(true);
    const startIdx = out.indexOf("<!-- flow-echo-recap:start -->");
    const endIdx = out.indexOf("<!-- flow-echo-recap:end -->");
    const snapIdx = out.indexOf("## PIPELINE SNAPSHOT");
    expect(startIdx).toBe(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    // The recap block fully precedes the snapshot header.
    expect(snapIdx).toBeGreaterThan(endIdx);
    // Carries the bounded fields + the two click targets (no trailing punct).
    expect(out).toContain("- PR URL: https://github.com/org/repo/pull/9");
    expect(out).toContain("- Plan file: /w/.flow-tmp/plan.md");
    expect(out).toContain("- branch: feat/echo");
    expect(out).toContain("- PR title: Echo recap");
    expect(out).toContain("- CI:");
    expect(out).toContain("- Review:");
    expect(out).toContain("- Follow-ups:");
    // The helper still emits NO stop-guard sentinel as its last line.
    expect(lastNonEmptyLine(out)).not.toBe("MERGED");
  });

  it("derives the bounded scalars from the read artifacts under --echo-prose", () => {
    const ciFile = write("ci-wait-result.json", '{"decision":"proceed"}');
    const reviewFile = write(
      "pr-review-result.json",
      '{"status":"clean","summary":"ok"}',
    );
    // Finding count falls back to fix-applier (commits + deferred) when no
    // consolidator artifact is present: 2 commits + 1 deferred = 3 findings;
    // follow-up count = 0 filed lines + 1 deferral = 1.
    const fixApplierFile = write(
      "fix-applier-result.json",
      JSON.stringify({
        commits: [
          {
            sha: "a1b2c3d",
            files: ["bin/lib/x.ts"],
            finding_id: "F1",
            reasoning: "added guard",
            verify_status: "pass",
          },
          {
            sha: "e4f5a6b",
            files: ["bin/lib/y.ts"],
            finding_id: "F2",
            reasoning: "renamed symbol",
            verify_status: "pass",
          },
        ],
        deferred: [
          {
            finding_id: "F3",
            tracker_entry_url: "",
            reason: "cross-cutting refactor",
          },
        ],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "applied two fixes, deferred one",
      }),
    );
    const out = captureStdout(() => {
      run(
        [
          "--status",
          "gated",
          "--echo-prose",
          "--ci-wait-result",
          ciFile,
          "--pr-review-result",
          reviewFile,
          "--fix-applier-result",
          fixApplierFile,
        ],
        { read: DEV_LENS_READ },
      );
    });
    expect(out).toContain("- CI: proceed");
    expect(out).toContain("- Review: clean (3 findings)");
    expect(out).toContain("- Follow-ups: 1");
  });

  it("renders a real `0` (not `none`) for genuine zero finding/follow-up counts under --echo-prose", () => {
    const reviewFile = write(
      "pr-review-result.json",
      '{"status":"clean","summary":"ok"}',
    );
    // A VALID consolidator with an empty findings array pins findingCount=0
    // (distinct from the undefined => `none` an absent artifact produces).
    const consolidatorFile = write(
      "consolidator-result.json",
      JSON.stringify({
        consolidated_findings: [],
        dropped_by_validation: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "ok",
      }),
    );
    // A fix-applier present but with zero deferrals + zero filed-issues lines
    // pins followupCount=0 (the `filedIssuesRaw.trim() || fixApplier` branch
    // fires, so 0 renders rather than collapsing to `none`).
    const fixApplierFile = write(
      "fix-applier-result.json",
      JSON.stringify({
        commits: [],
        deferred: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "nothing to fix",
      }),
    );
    const out = captureStdout(() => {
      run(
        [
          "--status",
          "gated",
          "--echo-prose",
          "--pr-review-result",
          reviewFile,
          "--consolidator-result",
          consolidatorFile,
          "--fix-applier-result",
          fixApplierFile,
        ],
        { read: DEV_LENS_READ },
      );
    });
    // A truthiness regression collapsing a legitimate 0 to `none` must fail here.
    expect(out).toContain("- Review: clean (0 findings)");
    expect(out).toContain("- Follow-ups: 0");
    expect(out).not.toContain("(none findings)");
    expect(out).not.toContain("- Follow-ups: none");
  });

  it("derives the real recap findingCount for a lens-name-labelled consolidator artifact", () => {
    const reviewFile = write(
      "pr-review-result.json",
      '{"status":"clean","summary":"ok"}',
    );
    // A well-formed consolidator whose one finding carries a lens-name label
    // ('consistency'). Before the deriveRecapScalars normalize fix, validation
    // failed here and findingCount fell through to the fix-applier fallback,
    // yielding a wrong recap count.
    const consolidatorFile = write(
      "consolidator-result.json",
      JSON.stringify({
        consolidated_findings: [
          {
            file: "bin/lib/x.ts",
            line: 10,
            label: "consistency",
            decoration: "non-blocking",
            confidence: 0.8,
            subject: "inconsistent naming",
            body: "rename to match sibling functions",
          },
        ],
        dropped_by_validation: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "ok",
      }),
    );
    // A fix-applier with 3 commits + 0 deferred would give findingCount=3 via
    // the fallback — so a wrong count is observably distinct from the real 1.
    const fixApplierFile = write(
      "fix-applier-result.json",
      JSON.stringify({
        commits: [
          { sha: "a", subject: "x" },
          { sha: "b", subject: "y" },
          { sha: "c", subject: "z" },
        ],
        deferred: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "fixed",
      }),
    );
    const out = captureStdout(() => {
      run(
        [
          "--status",
          "gated",
          "--echo-prose",
          "--pr-review-result",
          reviewFile,
          "--consolidator-result",
          consolidatorFile,
          "--fix-applier-result",
          fixApplierFile,
        ],
        { read: DEV_LENS_READ },
      );
    });
    expect(out).toContain("- Review: clean (1 findings)");
    expect(out).not.toContain("(3 findings)");
  });

  it("WITHOUT --echo-prose stdout is byte-for-byte unchanged (regression guard)", () => {
    const argv = ["--status", "merged"];
    const withFlag = captureStdout(() =>
      run([...argv, "--echo-prose"], { read: DEV_LENS_READ }),
    );
    const without = captureStdout(() => run(argv, { read: DEV_LENS_READ }));
    // The non-echo render carries no recap marker at all.
    expect(without).not.toContain("flow-echo-recap");
    // The echo run's tail (after the recap block) equals the whole non-echo run.
    const recapEnd = "<!-- flow-echo-recap:end -->\n\n";
    expect(withFlag.slice(withFlag.indexOf(recapEnd) + recapEnd.length)).toBe(
      without,
    );
  });

  it("derives artifactDir from --consolidator-result so the FORECLOSED PATHS disk fallback fires end-to-end", () => {
    // A consolidator artifact with no lens negatives, sitting alongside a
    // lens agent-output file in the same dir. Regression coverage for the
    // `artifactDir = parsed.consolidatorResult ? dirname(...) : undefined`
    // derivation at this CLI entry point (mirrors flow-foreclosed-paths.ts's
    // `runUpsert`, which had the equivalent derivation unreachable on a bare
    // invocation until fixed for #716).
    const consolidatorFile = write(
      "consolidator-result.json",
      JSON.stringify({
        consolidated_findings: [],
        dropped_by_validation: [],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "s",
      }),
    );
    write(
      "agent-output-security.json",
      JSON.stringify({
        rejected_alternatives: [
          {
            considered_approach: "store the token in localStorage",
            why_rejected: "XSS-exposed; used an httpOnly cookie instead",
          },
        ],
        anti_patterns_found: [],
      }),
    );
    const out = captureStdout(() => {
      run(["--status", "gated", "--consolidator-result", consolidatorFile], {
        read: DEV_LENS_READ,
      });
    });
    expect(out).toContain("store the token in localStorage");
  });
});

describe("run — --post-comment excludes the echo block", () => {
  it("the persisted comment body carries no flow-echo-recap marker", () => {
    const { gh, calls } = fakeGh([{ stdout: "[]" }]);
    const out = captureStdout(() => {
      run(
        [
          "--status",
          "merged",
          "--post-comment",
          "123",
          "--echo-prose",
          "--pr-url",
          "https://github.com/org/repo/pull/123",
          "--plan-file",
          "/w/.flow-tmp/plan.md",
        ],
        { gh },
      );
    });
    // Scrollback DOES carry the recap; the posted comment body does NOT.
    expect(out).toContain("flow-echo-recap:start");
    expect(calls[1].join("\n")).not.toContain("flow-echo-recap");
  });
});

// A recording fake gh runner: captures every argv and returns canned
// responses in order (defaulting to a success with empty stdout).
type GhResp = { stdout?: string; stderr?: string; exitCode?: number };
function fakeGh(responses: GhResp[] = []): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const gh: GhRunner = (argv) => {
    calls.push(argv);
    const r = responses[i] ?? {};
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
    };
  };
  return { gh, calls };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

describe("buildCommentBody / findMarkedCommentId", () => {
  it("fences the pm block and appends the marker after the closing </details>", () => {
    const pm = "PIPELINE SNAPSHOT\nCHANGES:\n  none";
    const dev = "PIPELINE SNAPSHOT\nCHANGES:\n  none\nPHASES:\n  none";
    const body = buildCommentBody(pm, dev);
    // Opening fence, then the pm block, then a closing fence, then the
    // collapsed dev block, then the marker.
    expect(body.startsWith("```text\n")).toBe(true);
    expect(body.endsWith(`\n\n${SNAPSHOT_MARKER}`)).toBe(true);
    expect(body).toContain(pm);
    expect(body).toContain(dev);
    expect(body).toContain("<details><summary>Developer detail</summary>");
    expect(body).toContain("</details>");
    // The marker sits OUTSIDE the fenced region and the <details> wrapper:
    // after the closing </details>.
    const detailsCloseIdx = body.lastIndexOf("</details>");
    const markerIdx = body.indexOf(SNAPSHOT_MARKER);
    expect(detailsCloseIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(detailsCloseIdx);
  });

  it("finds the first comment bearing the marker", () => {
    const json = JSON.stringify([
      { id: 1, body: "unrelated comment" },
      { id: 42, body: `old snapshot\n\n${SNAPSHOT_MARKER}` },
    ]);
    expect(findMarkedCommentId(json)).toBe(42);
  });

  it("returns null when no comment carries the marker", () => {
    const json = JSON.stringify([{ id: 1, body: "nope" }]);
    expect(findMarkedCommentId(json)).toBeNull();
  });

  it("returns null for unparseable or non-array responses", () => {
    expect(findMarkedCommentId("{not json")).toBeNull();
    expect(findMarkedCommentId(JSON.stringify({ id: 1 }))).toBeNull();
  });

  it("flattens the slurped multi-page shape (array-of-pages)", () => {
    // `gh api --paginate --slurp` wraps each page in an outer array; the
    // marked comment can live on any page. `.flat()` one level resolves it.
    const slurped = JSON.stringify([
      [{ id: 1, body: "x" }],
      [{ id: 2, body: `snap\n\n${SNAPSHOT_MARKER}` }],
    ]);
    expect(findMarkedCommentId(slurped)).toBe(2);
  });
});

describe("postSnapshotComment", () => {
  it("creates a new comment when none is marked", () => {
    const { gh, calls } = fakeGh([{ stdout: "[]" }]);
    const result = postSnapshotComment(
      123,
      "## PIPELINE SNAPSHOT\n…",
      "dev block",
      gh,
    );
    expect(result).toEqual({ action: "created" });
    // calls[0] lists; calls[1] POSTs the create.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("repos/{owner}/{repo}/issues/123/comments");
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]).toContain("--slurp");
    const create = calls[1];
    expect(create).toContain("repos/{owner}/{repo}/issues/123/comments");
    expect(create).not.toContain("PATCH");
    expect(create.join("\n")).toContain(SNAPSHOT_MARKER);
  });

  it("edits the existing comment in place when one is marked (dedup)", () => {
    const listJson = JSON.stringify([
      { id: 555, body: `old\n\n${SNAPSHOT_MARKER}` },
    ]);
    const { gh, calls } = fakeGh([{ stdout: listJson }]);
    const result = postSnapshotComment(
      123,
      "## PIPELINE SNAPSHOT\nnew",
      "dev block",
      gh,
    );
    expect(result).toEqual({ action: "updated", id: 555 });
    const patch = calls[1];
    expect(patch).toContain("repos/{owner}/{repo}/issues/comments/555");
    expect(patch).toContain("PATCH");
    // Zero create POSTs: no call writes a body to the /issues/123/comments path.
    const creates = calls.filter(
      (c) =>
        c.includes("repos/{owner}/{repo}/issues/123/comments") &&
        c.includes("-f"),
    );
    expect(creates).toHaveLength(0);
  });

  it("returns failed (never throws) when the list call exits non-zero", () => {
    const { gh, calls } = fakeGh([{ exitCode: 1, stderr: "boom" }]);
    const result = postSnapshotComment(123, "block", "dev block", gh);
    expect(result.action).toBe("failed");
    expect(calls).toHaveLength(1); // bailed after the failed list, no write
  });

  it("returns failed when the create (POST) call exits non-zero", () => {
    // list ok (empty -> no marked comment), then the create POST is denied.
    const { gh, calls } = fakeGh([
      { stdout: "[]" },
      { exitCode: 1, stderr: "create denied" },
    ]);
    const result = postSnapshotComment(123, "block", "dev block", gh);
    expect(result).toEqual({ action: "failed", error: "create denied" });
    expect(calls).toHaveLength(2);
  });

  it("returns failed with the PATCH fallback message when the edit fails with empty stderr", () => {
    const listJson = JSON.stringify([
      { id: 9, body: `old\n\n${SNAPSHOT_MARKER}` },
    ]);
    // list finds a marked comment, then the PATCH edit fails with no stderr,
    // exercising the `gh api PATCH failed (<code>)` fallback message.
    const { gh, calls } = fakeGh([
      { stdout: listJson },
      { exitCode: 1, stderr: "" },
    ]);
    const result = postSnapshotComment(123, "block", "dev block", gh);
    expect(result).toEqual({
      action: "failed",
      error: "gh api PATCH failed (1)",
    });
    expect(calls[1]).toContain("PATCH");
  });
});

describe("run — --post-comment write path", () => {
  it("posts (create) on MERGED with the marker, exactly one create call", () => {
    const { gh, calls } = fakeGh([{ stdout: "[]" }]);
    const out = captureStdout(() => {
      const code = run(["--status", "merged", "--post-comment", "123"], {
        gh,
        read: DEV_LENS_READ,
      });
      expect(code).toBe(0);
    });
    // One list + one create.
    expect(calls).toHaveLength(2);
    const patchCalls = calls.filter((c) => c.includes("PATCH"));
    expect(patchCalls).toHaveLength(0);
    // The marker is in the posted comment body but NEVER in scrollback.
    expect(calls[1].join("\n")).toContain(SNAPSHOT_MARKER);
    expect(out).toContain("## PIPELINE SNAPSHOT");
    expect(out).not.toContain(SNAPSHOT_MARKER);
  });

  it("edits-not-duplicates on a re-run with a marked comment present", () => {
    const listJson = JSON.stringify([
      { id: 777, body: `prior\n\n${SNAPSHOT_MARKER}` },
    ]);
    const { gh, calls } = fakeGh([{ stdout: listJson }]);
    captureStdout(() =>
      run(["--status", "merged", "--post-comment", "123"], {
        gh,
        read: DEV_LENS_READ,
      }),
    );
    expect(calls.some((c) => c.includes("PATCH"))).toBe(true);
    const creates = calls.filter(
      (c) =>
        c.includes("repos/{owner}/{repo}/issues/123/comments") &&
        c.includes("-f"),
    );
    expect(creates).toHaveLength(0);
  });

  it("makes zero gh write calls on a non-merged status (MERGED-only)", () => {
    const { gh, calls } = fakeGh();
    captureStdout(() =>
      run(["--status", "gated", "--post-comment", "123"], {
        gh,
        read: DEV_LENS_READ,
      }),
    );
    expect(calls).toHaveLength(0);
  });

  it("is best-effort: a gh failure does not throw or change the exit code", () => {
    const { gh } = fakeGh([{ exitCode: 1, stderr: "rate limited" }]);
    let code = -1;
    const out = captureStdout(() => {
      code = run(["--status", "merged", "--post-comment", "123"], {
        gh,
        read: DEV_LENS_READ,
      });
    });
    expect(code).toBe(0);
    expect(out).toContain("## PIPELINE SNAPSHOT");
  });

  it("leaves scrollback untouched and gh unused when --post-comment is absent", () => {
    const { gh, calls } = fakeGh();
    const out = captureStdout(() =>
      run(["--status", "merged"], { gh, read: DEV_LENS_READ }),
    );
    expect(calls).toHaveLength(0);
    expect(out).not.toContain(SNAPSHOT_MARKER);
  });

  it("best-effort: a malformed --post-comment PR arg exits 0, still prints, and never calls gh", () => {
    // parsePrNumber throws on a non-numeric, non-URL value; the catch turns
    // it into a stderr line + exit 0 BEFORE postSnapshotComment runs.
    const { gh, calls } = fakeGh();
    let code = -1;
    const out = captureStdout(() => {
      code = run(["--status", "merged", "--post-comment", "not-a-pr"], {
        gh,
        read: DEV_LENS_READ,
      });
    });
    expect(code).toBe(0);
    expect(out).toContain("## PIPELINE SNAPSHOT");
    expect(calls).toHaveLength(0);
  });

  it("no-ops on an empty --post-comment value (the empty-$PR contract)", () => {
    // `--post-comment ""` parses as a falsy postComment, short-circuiting the
    // merged-and-postComment guard so no gh call fires.
    const { gh, calls } = fakeGh();
    let code = -1;
    captureStdout(() => {
      code = run(["--status", "merged", "--post-comment", ""], {
        gh,
        read: DEV_LENS_READ,
      });
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// A populated fixture exercising every slim-comment section: a diff summary,
// a review verdict, a fix-applier with a deferred entry + a rejected
// alternative, and a consolidator with its own (string) rejected alternative.
const POPULATED_COMMENT_INPUTS = {
  prChangesRaw: JSON.stringify({
    additions: 40,
    deletions: 7,
    changedFiles: 5,
    commits: 3,
  }),
  prReviewRaw: JSON.stringify({
    status: "partial",
    completed_steps: [],
    missed_steps: ["x"],
    escalation_tag: null,
    summary: "two findings open",
  }),
  fixApplierRaw: JSON.stringify({
    commits: [],
    deferred: [
      {
        finding_id: "F2",
        tracker_entry_url: "https://github.com/o/r/issues/2",
        reason: "later",
      },
    ],
    rejected_alternatives: [
      {
        finding_id: "F1",
        considered_approach: "inline the helper",
        why_rejected: "would break the seam",
      },
    ],
    anti_patterns_found: [],
    summary: "s",
  }),
  consolidatorRaw: JSON.stringify({
    consolidated_findings: [],
    dropped_by_validation: [],
    rejected_alternatives: ["dropped a duplicate security finding"],
    anti_patterns_found: [],
    summary: "ok",
  }),
  ciWaitRaw: JSON.stringify({
    decision: "proceed-to-review",
    copilotConfigured: true,
    copilotSkipReason: null,
  }),
  filedIssuesRaw: "filed\thttps://github.com/o/r/issues/1",
};

const EMPTY_COMMENT_INPUTS = {
  prChangesRaw: "",
  prReviewRaw: "",
  fixApplierRaw: "",
  consolidatorRaw: "",
  ciWaitRaw: "",
  filedIssuesRaw: "",
};

describe("renderComment — slim PR-comment block (dev)", () => {
  it("surfaces change summary, review verdict, deferred + rejected decisions", () => {
    const block = renderComment(POPULATED_COMMENT_INPUTS).dev;
    // Plain title line, no leading `##`.
    expect(block.startsWith("PIPELINE SNAPSHOT")).toBe(true);
    expect(block).not.toContain("## PIPELINE SNAPSHOT");
    // CHANGES one-liner (reused from renderChanges).
    expect(block).toContain("3 commits, +40/-7 across 5 files");
    // REVIEW verdict / findings disposition (reused from renderFindings).
    expect(block).toContain("REVIEW:");
    expect(block).toContain("review: partial — two findings open");
    // DECISIONS: deferred line(s).
    expect(block).toContain("DECISIONS:");
    expect(block).toContain(
      "pr-review deferral: https://github.com/o/r/issues/2",
    );
    // PHASES and MANUAL STEPS are dropped entirely from the slim block.
    expect(block).not.toContain("PHASES:");
    expect(block).not.toContain("MANUAL STEPS:");
  });

  it("surfaces rejected_alternatives from BOTH fix-applier and consolidator", () => {
    const block = renderComment(POPULATED_COMMENT_INPUTS).dev;
    // Fix-applier rejected_alternatives are objects → `id: approach — why`.
    expect(block).toContain("F1: inline the helper — would break the seam");
    // Consolidator rejected_alternatives are plain strings.
    expect(block).toContain("dropped a duplicate security finding");
  });

  it("renders the literal `none` for empty deferred, rejected, and anti-pattern parts", () => {
    const block = renderComment(EMPTY_COMMENT_INPUTS).dev;
    // All three DECISIONS sub-parts collapse to the explicit `none` discipline.
    expect(block).toContain("deferred:");
    expect(block).toContain("rejected:");
    expect(block).toContain("anti-patterns:");
    // Each empty sub-part prints `none`.
    expect(block).toMatch(/deferred:\n\s+none/);
    expect(block).toMatch(/rejected:\n\s+none/);
    expect(block).toMatch(/anti-patterns:\n\s+none/);
    // CHANGES and REVIEW also fall back to `none`.
    expect(block).toContain("CHANGES:");
    expect(block).toContain("REVIEW:");
  });

  it("includes an INTENT section when the verdict is non-match", () => {
    const block = renderComment({
      ...POPULATED_COMMENT_INPUTS,
      intentResolutionRaw: JSON.stringify({
        verdict: "scope-drift",
        guessed_purpose: "x",
        resolution: "guess vs request diverge on scope",
        cross_model: { ran: false, agreement: null },
      }),
    }).dev;
    expect(block).toContain("INTENT:");
    expect(block).toContain("scope-drift: guess vs request diverge on scope");
  });

  it("omits the INTENT section when the verdict is match", () => {
    const block = renderComment({
      ...POPULATED_COMMENT_INPUTS,
      intentResolutionRaw: JSON.stringify({
        verdict: "match",
        guessed_purpose: "x",
        resolution: "guess matches request",
        cross_model: { ran: false, agreement: null },
      }),
    }).dev;
    expect(block).not.toContain("INTENT:");
  });

  it("omits the INTENT section when the artifact is absent", () => {
    const block = renderComment(POPULATED_COMMENT_INPUTS).dev;
    expect(block).not.toContain("INTENT:");
  });

  it("omits the INTENT section when the artifact is present but unparseable", () => {
    const block = renderComment({
      ...POPULATED_COMMENT_INPUTS,
      intentResolutionRaw: "{not json",
    }).dev;
    expect(block).not.toContain("INTENT:");
  });
});

describe("renderComment — slim PR-comment block (pm)", () => {
  it("has exactly CHANGES / REVIEW / DEVIATIONS / UNTRACKED, never the review: narrative", () => {
    const block = renderComment(POPULATED_COMMENT_INPUTS).pm;
    expect(block.startsWith("PIPELINE SNAPSHOT")).toBe(true);
    expect(block).toContain("CHANGES:");
    expect(block).toContain("3 commits, +40/-7 across 5 files");
    expect(block).toContain("REVIEW:");
    expect(block).toContain("partial — 0 findings fixed, 1 deferred");
    expect(block).not.toContain("review: partial — two findings open");
    expect(block).toContain("DEVIATIONS:");
    expect(block).toContain(
      "deferred → https://github.com/o/r/issues/2 (later)",
    );
    expect(block).toContain("UNTRACKED:");
    expect(block).not.toContain("DECISIONS:");
    expect(block).not.toContain("PHASES:");
    expect(block).not.toContain("MANUAL STEPS:");
  });

  it("renders `none` for empty REVIEW/DEVIATIONS/UNTRACKED", () => {
    const block = renderComment(EMPTY_COMMENT_INPUTS).pm;
    expect(block).toMatch(/REVIEW:\n\s+none/);
    expect(block).toMatch(/DEVIATIONS:\n\s+none/);
    expect(block).toMatch(/UNTRACKED:\n\s+none/);
  });

  it("threads scoutRaw PLAN-DEVIATION bullets and untrackedBlock lines", () => {
    const block = renderComment({
      ...POPULATED_COMMENT_INPUTS,
      scoutRaw:
        "## open_questions\n\n- PLAN-DEVIATION: moved to a sibling module\n",
      untrackedBlock: "- #1 found a bug",
    }).pm;
    expect(block).toContain("moved to a sibling module");
    expect(block).toContain("- #1 found a bug");
  });
});

describe("buildCommentBody round-trip with findMarkedCommentId", () => {
  it("dedups a fenced pm+dev body and keeps the marker outside the wrapper", () => {
    const { pm, dev } = renderComment(POPULATED_COMMENT_INPUTS);
    const body = buildCommentBody(pm, dev);
    // Round-trip through the dedup lookup: a comment carrying this body resolves.
    const listJson = JSON.stringify([{ id: 314, body }]);
    expect(findMarkedCommentId(listJson)).toBe(314);
    // Marker index is greater than the closing-</details> index (outside).
    const detailsCloseIdx = body.lastIndexOf("</details>");
    const markerIdx = body.indexOf(SNAPSHOT_MARKER);
    expect(markerIdx).toBeGreaterThan(detailsCloseIdx);
  });
});

describe("run — slim comment vs unchanged scrollback", () => {
  it("posts the slim fenced+marked block while scrollback stays full and clean", () => {
    const { gh, calls } = fakeGh([{ stdout: "[]" }]);
    const out = captureStdout(() => {
      const code = run(["--status", "merged", "--post-comment", "123"], {
        gh,
        read: DEV_LENS_READ,
      });
      expect(code).toBe(0);
    });
    // Scrollback: all five sections present, 2-space indentation preserved,
    // and NO fence or marker.
    for (const header of [
      "CHANGES:",
      "PHASES:",
      "FINDINGS:",
      "FOLLOW-UP ISSUES:",
      "MANUAL STEPS:",
    ]) {
      expect(out).toContain(header);
    }
    expect(out).toContain("## PIPELINE SNAPSHOT");
    expect(out).toContain("\n  none");
    expect(out).not.toContain("```text");
    expect(out).not.toContain(SNAPSHOT_MARKER);
    // The gh comment-create body DOES carry the fence + marker, and does NOT
    // carry the dropped scrollback-only sections.
    const createBody = calls[1].join("\n");
    expect(createBody).toContain("```text");
    expect(createBody).toContain(SNAPSHOT_MARKER);
    expect(createBody).not.toContain("PHASES:");
    expect(createBody).not.toContain("MANUAL STEPS:");
  });
});
