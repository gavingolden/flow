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
  it("fences the block and appends the marker after the closing fence", () => {
    const block = "PIPELINE SNAPSHOT\nCHANGES:\n  none";
    const body = buildCommentBody(block);
    // Opening fence, then the block, then a closing fence, then the marker.
    expect(body.startsWith("```text\n")).toBe(true);
    expect(body.endsWith(`\n\n${SNAPSHOT_MARKER}`)).toBe(true);
    expect(body).toContain(block);
    // The marker sits OUTSIDE the fenced region: after the closing fence.
    const closingFenceIdx = body.lastIndexOf("\n```");
    const markerIdx = body.indexOf(SNAPSHOT_MARKER);
    expect(closingFenceIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(closingFenceIdx);
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
    const result = postSnapshotComment(123, "## PIPELINE SNAPSHOT\n…", gh);
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
    const result = postSnapshotComment(123, "## PIPELINE SNAPSHOT\nnew", gh);
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
    const result = postSnapshotComment(123, "block", gh);
    expect(result.action).toBe("failed");
    expect(calls).toHaveLength(1); // bailed after the failed list, no write
  });

  it("returns failed when the create (POST) call exits non-zero", () => {
    // list ok (empty -> no marked comment), then the create POST is denied.
    const { gh, calls } = fakeGh([
      { stdout: "[]" },
      { exitCode: 1, stderr: "create denied" },
    ]);
    const result = postSnapshotComment(123, "block", gh);
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
    const result = postSnapshotComment(123, "block", gh);
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
      const code = run(["--status", "merged", "--post-comment", "123"], { gh });
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
      run(["--status", "merged", "--post-comment", "123"], { gh }),
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
      run(["--status", "gated", "--post-comment", "123"], { gh }),
    );
    expect(calls).toHaveLength(0);
  });

  it("is best-effort: a gh failure does not throw or change the exit code", () => {
    const { gh } = fakeGh([{ exitCode: 1, stderr: "rate limited" }]);
    let code = -1;
    const out = captureStdout(() => {
      code = run(["--status", "merged", "--post-comment", "123"], { gh });
    });
    expect(code).toBe(0);
    expect(out).toContain("## PIPELINE SNAPSHOT");
  });

  it("leaves scrollback untouched and gh unused when --post-comment is absent", () => {
    const { gh, calls } = fakeGh();
    const out = captureStdout(() => run(["--status", "merged"], { gh }));
    expect(calls).toHaveLength(0);
    expect(out).not.toContain(SNAPSHOT_MARKER);
  });

  it("best-effort: a malformed --post-comment PR arg exits 0, still prints, and never calls gh", () => {
    // parsePrNumber throws on a non-numeric, non-URL value; the catch turns
    // it into a stderr line + exit 0 BEFORE postSnapshotComment runs.
    const { gh, calls } = fakeGh();
    let code = -1;
    const out = captureStdout(() => {
      code = run(["--status", "merged", "--post-comment", "not-a-pr"], { gh });
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
      code = run(["--status", "merged", "--post-comment", ""], { gh });
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

describe("renderComment — slim PR-comment block", () => {
  it("surfaces change summary, review verdict, deferred + rejected decisions", () => {
    const block = renderComment(POPULATED_COMMENT_INPUTS);
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
    const block = renderComment(POPULATED_COMMENT_INPUTS);
    // Fix-applier rejected_alternatives are objects → `id: approach — why`.
    expect(block).toContain("F1: inline the helper — would break the seam");
    // Consolidator rejected_alternatives are plain strings.
    expect(block).toContain("dropped a duplicate security finding");
  });

  it("renders the literal `none` for empty deferred and rejected parts", () => {
    const block = renderComment(EMPTY_COMMENT_INPUTS);
    // Both DECISIONS sub-parts collapse to the explicit `none` discipline.
    expect(block).toContain("deferred:");
    expect(block).toContain("rejected:");
    // Each empty sub-part prints `none`.
    expect(block).toMatch(/deferred:\n\s+none/);
    expect(block).toMatch(/rejected:\n\s+none/);
    // CHANGES and REVIEW also fall back to `none`.
    expect(block).toContain("CHANGES:");
    expect(block).toContain("REVIEW:");
  });
});

describe("buildCommentBody round-trip with findMarkedCommentId", () => {
  it("dedups a fenced slim body and keeps the marker outside the fence", () => {
    const body = buildCommentBody(renderComment(POPULATED_COMMENT_INPUTS));
    // Round-trip through the dedup lookup: a comment carrying this body resolves.
    const listJson = JSON.stringify([{ id: 314, body }]);
    expect(findMarkedCommentId(listJson)).toBe(314);
    // Marker index is greater than the closing-fence index (outside the fence).
    const closingFenceIdx = body.lastIndexOf("\n```");
    const markerIdx = body.indexOf(SNAPSHOT_MARKER);
    expect(markerIdx).toBeGreaterThan(closingFenceIdx);
  });
});

describe("run — slim comment vs unchanged scrollback", () => {
  it("posts the slim fenced+marked block while scrollback stays full and clean", () => {
    const { gh, calls } = fakeGh([{ stdout: "[]" }]);
    const out = captureStdout(() => {
      const code = run(["--status", "merged", "--post-comment", "123"], { gh });
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
