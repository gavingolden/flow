import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, render, run } from "./flow-pipeline-summary";
import { writeState, type PipelineState } from "./lib/state";

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
});

describe("render — explicit none discipline", () => {
  it("prints all five sections with `none` when every source is empty", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("## PIPELINE SNAPSHOT");
    for (const header of [
      "CHANGES:",
      "PHASES:",
      "FINDINGS:",
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
      "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow setup --upgrade  (exit 0)";
    const out = render({ ...EMPTY_RENDER, manualStepsBlock: block });
    expect(out).toContain("LOCAL FOLLOW-UPS: 1 ran");
    expect(out).toContain("RAN     flow setup --upgrade  (exit 0)");
  });

  it("renders `MANUAL STEPS: none` for an empty block", () => {
    const out = render(EMPTY_RENDER);
    expect(out).toContain("MANUAL STEPS:\n  none");
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
      const code = run([
        "--status",
        "merged",
        "--state-file",
        path.join(tmpRoot, "demo.json"),
      ]);
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
      run([
        "--status",
        "needs-human",
        "--state-file",
        path.join(tmpRoot, "missing.json"),
      ]);
    });
    expect(out).toContain("PHASES:\n  none");
  });

  it("the --followups-block-file pass-through preserves the captured text", () => {
    const blockFile = write(
      "followups-block.txt",
      "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow setup --upgrade  (exit 0)\n",
    );
    const out = captureStdout(() => {
      run(["--status", "merged", "--followups-block-file", blockFile]);
    });
    expect(out).toContain("RAN     flow setup --upgrade  (exit 0)");
  });

  it("renders the --followups-jsonl note-only verdict (never re-executing entries)", () => {
    const jsonl = write(
      "local-followups.jsonl",
      JSON.stringify({
        id: "abc123",
        command: "flow setup --upgrade",
        reason: "new helper landed",
        auto: true,
        registeredAt: "t1",
      }) + "\n",
    );
    const out = captureStdout(() => {
      run(["--status", "gated", "--followups-jsonl", jsonl]);
    });
    // noteOnly: true => the auto-allowlisted entry is NOTED, not run, and the
    // header carries the deferred verdict.
    expect(out).toContain("LOCAL FOLLOW-UPS (deferred — PR not yet merged)");
    expect(out).toContain("flow setup --upgrade");
    expect(out).not.toContain("RAN     flow setup --upgrade");
  });

  it("prefers --followups-block-file over --followups-jsonl when both are passed", () => {
    const blockFile = write(
      "followups-block.txt",
      "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow setup --upgrade  (exit 0)\n",
    );
    const jsonl = write(
      "local-followups.jsonl",
      JSON.stringify({
        id: "abc123",
        command: "flow setup --upgrade",
        reason: "new helper landed",
        auto: true,
        registeredAt: "t1",
      }) + "\n",
    );
    const out = captureStdout(() => {
      run([
        "--status",
        "merged",
        "--followups-block-file",
        blockFile,
        "--followups-jsonl",
        jsonl,
      ]);
    });
    // Block-file wins: the captured ran/failed results are preserved and the
    // jsonl note-only fallback never fires.
    expect(out).toContain("RAN     flow setup --upgrade  (exit 0)");
    expect(out).not.toContain(
      "LOCAL FOLLOW-UPS (deferred — PR not yet merged)",
    );
  });
});
