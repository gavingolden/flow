import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NEXT_ACTION,
  NEXT_ACTION_BY_REASON,
  parseArgs,
  render,
  renderCleanup,
  run,
  type CleanupInput,
} from "./flow-gate-summary";
import { writeState, type PipelineState } from "./lib/state";

let tmpRoot!: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-gate-summary-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Universal sentinel-line invariant: every non-awaiting-approval status
// renders with the byte-exact sentinel as its final non-empty line.
function finalLine(rendered: string): string {
  return (
    rendered
      .split("\n")
      .filter((l) => l !== "")
      .pop() ?? ""
  );
}

describe("render — merged", () => {
  it("includes STATUS, PR, NEXT ACTION rows and sentinel", () => {
    const out = render({
      status: "merged",
      prUrl: "https://github.com/org/repo/pull/142",
    });
    expect(out).toBe(
      [
        "STATUS: MERGED",
        "PR: https://github.com/org/repo/pull/142",
        "NEXT ACTION: none (post-merge cleanup already ran)",
        "MERGED",
      ].join("\n"),
    );
    expect(finalLine(out)).toBe("MERGED");
  });

  it("embeds the deferred block when non-empty", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      deferredBlock:
        "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow install --upgrade  (exit 0)",
    });
    expect(out).toContain("FOLLOW-UPS:");
    expect(out).toContain("  LOCAL FOLLOW-UPS: 1 ran");
    expect(out).toContain("  RAN     flow install --upgrade  (exit 0)");
    expect(finalLine(out)).toBe("MERGED");
  });

  it("strips formatVerdict's 2-space indent and collapses blank lines", () => {
    // Mirrors flow-followups.formatVerdict's note-only output exactly:
    // header row, blank separator, 2-space-indented bullet. The helper
    // is the single source of truth for what's under FOLLOW-UPS:, so
    // the rendered block must be a clean 2-space indent throughout
    // with no whitespace-only lines.
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      deferredBlock:
        "LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed\n" +
        "\n" +
        "  - [ ]   flow install --upgrade  # new helper landed (auto)",
    });
    const lines = out.split("\n");
    const idx = lines.findIndex((l) => l === "FOLLOW-UPS:");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The two lines following FOLLOW-UPS: must be the header row and
    // the entry bullet, each at a clean 2-space indent (the blank
    // separator between them is collapsed).
    expect(lines[idx + 1]).toBe(
      "  LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed",
    );
    expect(lines[idx + 2]).toBe(
      "  - [ ]   flow install --upgrade  # new helper landed (auto)",
    );
    // No whitespace-only lines and no 4-space-indented lines anywhere
    // in the rendered block.
    for (const ln of lines) {
      expect(ln === "" || ln.trim().length > 0).toBe(true);
      expect(ln.startsWith("    ")).toBe(false);
    }
  });

  it("suppresses FOLLOW-UPS when deferredBlock is empty", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      deferredBlock: "",
    });
    expect(out).not.toContain("FOLLOW-UPS");
    expect(finalLine(out)).toBe("MERGED");
  });

  it("suppresses FOLLOW-UPS when deferredBlock is whitespace-only", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      deferredBlock: "   \n\n",
    });
    expect(out).not.toContain("FOLLOW-UPS");
  });

  it("suppresses FOLLOW-UPS when deferredBlock is undefined", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
    });
    expect(out).not.toContain("FOLLOW-UPS");
  });

  it("renders WHY when provided (merged-externally context)", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      why: "PR was merged externally mid-flight; supervisor cleaned up worktree",
    });
    expect(out).toContain("WHY: PR was merged externally mid-flight");
  });
});

describe("render — gated", () => {
  it("renders STATUS, PR, WHY, NEXT ACTION, items, sentinel", () => {
    const out = render({
      status: "gated",
      prUrl: "https://github.com/org/repo/pull/142",
      why: "2 unchecked test steps remain",
      validationItems: [
        "Open /portfolio with the seeded user — chart renders",
        "Switch time range to 1y — chart updates",
      ],
    });
    expect(out.split("\n")[0]).toBe("STATUS: GATED");
    expect(finalLine(out)).toBe("GATED: https://github.com/org/repo/pull/142");
    expect(out).toContain("PR: https://github.com/org/repo/pull/142");
    expect(out).toContain("WHY: 2 unchecked test steps remain");
    expect(out).toContain(
      "NEXT ACTION: validate then run: gh pr merge --squash 142",
    );
    expect(out).toContain(
      "  - Open /portfolio with the seeded user — chart renders",
    );
    expect(out).toContain("  - Switch time range to 1y — chart updates");
  });

  it("renders gated with empty validation items (no-auto-merge opted out)", () => {
    const out = render({
      status: "gated",
      prUrl: "https://example/pr/1",
      why: "auto-merge opted out (--no-auto-merge)",
      validationItems: [],
    });
    // Still has NEXT ACTION referencing the merge command — the
    // helper does not gate on item presence; absence just means no
    // bulleted items appear.
    expect(out).toContain(
      "NEXT ACTION: validate then run: gh pr merge --squash 1",
    );
    expect(out.split("\n").filter((l) => l.startsWith("  - "))).toEqual([]);
    expect(finalLine(out)).toBe("GATED: https://example/pr/1");
  });

  it("strips pre-bulleted items to avoid double-prefixing", () => {
    const out = render({
      status: "gated",
      prUrl: "https://example/pr/1",
      validationItems: ["- pre-bulleted item", "* asterisk item", "raw item"],
    });
    expect(out).toContain("  - pre-bulleted item");
    expect(out).toContain("  - asterisk item");
    expect(out).toContain("  - raw item");
    // No double-prefix `  - - pre-bulleted` line.
    expect(out).not.toContain("- -");
  });

  it("falls back to <pr> placeholder when prUrl missing", () => {
    const out = render({
      status: "gated",
      why: "no URL given",
    });
    expect(out).toContain(
      "NEXT ACTION: validate then run: gh pr merge --squash <pr>",
    );
    expect(finalLine(out)).toBe("GATED:");
  });

  it("embeds FOLLOW-UPS when non-empty", () => {
    const out = render({
      status: "gated",
      prUrl: "https://example/pr/1",
      validationItems: ["one"],
      deferredBlock:
        "LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed",
    });
    expect(out).toContain("FOLLOW-UPS:");
    expect(out).toContain("  LOCAL FOLLOW-UPS (deferred");
    expect(finalLine(out)).toBe("GATED: https://example/pr/1");
  });
});

describe("render — needs-human (per-reason mapping)", () => {
  // Iterate every documented reason in NEXT_ACTION_BY_REASON, asserting
  // the helper picks up the mapped NEXT ACTION text.
  for (const reason of Object.keys(NEXT_ACTION_BY_REASON)) {
    it(`maps reason '${reason}' to its NEXT_ACTION_BY_REASON entry`, () => {
      const out = render({ status: "needs-human", reason });
      expect(NEXT_ACTION_BY_REASON[reason]).toBeTruthy();
      expect(out).toContain(`NEXT ACTION: ${NEXT_ACTION_BY_REASON[reason]}`);
      expect(finalLine(out)).toBe(`NEEDS HUMAN: ${reason}`);
    });
  }

  it("maps smoketest-needs-creds to a concrete resume instruction + sentinel (Story 7)", () => {
    const out = render({
      status: "needs-human",
      reason: "smoketest-needs-creds",
    });
    expect(out).toContain(
      `NEXT ACTION: ${NEXT_ACTION_BY_REASON["smoketest-needs-creds"]}`,
    );
    expect(out).toContain("credentialEnvVars");
    expect(out).toContain("flow feature resume");
    expect(finalLine(out)).toBe("NEEDS HUMAN: smoketest-needs-creds");
    // The reason tag must stay colon-free so nextActionForReason (which splits
    // on the first ':') resolves the full mapping.
    expect("smoketest-needs-creds".includes(":")).toBe(false);
  });

  it("maps merge-resolver-spawn-denied to a manual git-merge recovery recipe", () => {
    const out = render({
      status: "needs-human",
      reason: "merge-resolver-spawn-denied",
    });
    expect(out).toContain("git merge origin/");
    expect(finalLine(out)).toBe("NEEDS HUMAN: merge-resolver-spawn-denied");
    // Pin the recipe's load-bearing negatives — the generic
    // Object.keys(NEXT_ACTION_BY_REASON) loop above only checks the
    // reason renders at all, not that its content stays correct.
    const recipe = NEXT_ACTION_BY_REASON["merge-resolver-spawn-denied"];
    expect(recipe).toContain("do NOT force");
    // The resolve step must visibly interrupt any `&&` chain rather than
    // being buried inside one — a bare `&&`-chained "resolve conflicts"
    // step is easy to blow past without human judgment. The recipe is
    // now a numbered multi-step recipe (see `## Step contract` in
    // pause-output-contract.md); re-express the same safety property
    // against that shape rather than the old ";  then STOP" phrasing:
    // the STOP instruction is its own numbered step line, and no
    // single step line mixes `&&` and `STOP`.
    const stepLines = recipe.split("\n").filter((l) => /^\s*\d+\.\s/.test(l));
    expect(stepLines.some((l) => /\bSTOP\b/.test(l))).toBe(true);
    expect(stepLines.some((l) => /&&/.test(l) && /\bSTOP\b/.test(l))).toBe(
      false,
    );
    // Whole-recipe backstop: no single line — including the header or an
    // indented detail sub-bullet, neither of which `stepLines` above
    // covers — may mix an `&&` chain with the STOP instruction.
    expect(recipe).not.toMatch(/&&[^\n]*\bSTOP\b/i);
    // Ordering is the safety property: STOP must precede the commit step,
    // otherwise conflict markers get committed before the human resolves
    // them.
    const stopIdx = stepLines.findIndex((l) => /\bSTOP\b/.test(l));
    const commitIdx = stepLines.findIndex((l) => /\bgit commit\b/.test(l));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(stopIdx);
  });

  it("falls back to DEFAULT_NEXT_ACTION for an unmapped reason", () => {
    const out = render({ status: "needs-human", reason: "made-up-tag" });
    expect(out).toContain(`NEXT ACTION: ${DEFAULT_NEXT_ACTION}`);
    expect(finalLine(out)).toBe("NEEDS HUMAN: made-up-tag");
  });

  it("falls back to DEFAULT_NEXT_ACTION when no reason is provided", () => {
    const out = render({ status: "needs-human" });
    expect(out).toContain(`NEXT ACTION: ${DEFAULT_NEXT_ACTION}`);
    expect(finalLine(out)).toBe("NEEDS HUMAN: <reason>");
  });

  it("substitutes the site name into task-tool-unavailable mapping", () => {
    const out = render({
      status: "needs-human",
      reason: "task-tool-unavailable: pr-review-fix-applier",
    });
    // The NEXT ACTION must carry the spawn site as appended context so
    // the rendered block names the exact remediation for each of the
    // six exemption sites; without this, all six collapse to the same
    // generic line. task-tool-unavailable is now a multi-line (header +
    // numbered steps) recipe, so the suffix must land on the header
    // line (the `NEXT ACTION:` row) — never on the final step line.
    const mapped = NEXT_ACTION_BY_REASON["task-tool-unavailable"];
    const header = mapped.split("\n")[0];
    expect(out).toContain(
      `NEXT ACTION: ${header} (spawn site: pr-review-fix-applier)`,
    );
    const lastLine = mapped.split("\n").at(-1)!;
    expect(out).not.toContain(`${lastLine} (spawn site:`);
    expect(finalLine(out)).toBe(
      "NEEDS HUMAN: task-tool-unavailable: pr-review-fix-applier",
    );
    expect(out).toContain("WHY: task-tool-unavailable: pr-review-fix-applier");
  });

  it("does not append site context when task-tool-unavailable suffix is empty", () => {
    // Defensive: a malformed reason ("task-tool-unavailable:" with no
    // suffix) falls back to the bare mapping; no parenthesised tail.
    const out = render({
      status: "needs-human",
      reason: "task-tool-unavailable:",
    });
    expect(out).toContain(
      `NEXT ACTION: ${NEXT_ACTION_BY_REASON["task-tool-unavailable"]}`,
    );
    expect(out).not.toContain("(spawn site:");
  });

  it("renders PR URL when provided alongside reason", () => {
    const out = render({
      status: "needs-human",
      reason: "pr-closed-without-merge",
      prUrl: "https://example/pr/9",
    });
    expect(out).toContain("PR: https://example/pr/9");
    expect(out).toContain(
      `NEXT ACTION: ${NEXT_ACTION_BY_REASON["pr-closed-without-merge"]}`,
    );
    expect(finalLine(out)).toBe("NEEDS HUMAN: pr-closed-without-merge");
  });

  it("collapses multiline why into a single row", () => {
    const out = render({
      status: "needs-human",
      reason: "gh-error",
      why: "gh pr view failed\nauth refused\nexit 1",
    });
    const whyLines = out.split("\n").filter((l) => l.startsWith("WHY:"));
    expect(whyLines).toHaveLength(1);
    expect(whyLines[0]).toBe("WHY: gh pr view failed auth refused exit 1");
  });

  it("renders FOLLOW-UPS block before the sentinel", () => {
    const out = render({
      status: "needs-human",
      reason: "merge-failed",
      why: "merge conflict in src/foo.ts",
      deferredBlock:
        "LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed",
    });
    const lines = out.split("\n");
    const deferredIdx = lines.findIndex((l) => l === "FOLLOW-UPS:");
    const sentinelIdx = lines.findIndex(
      (l) => l === "NEEDS HUMAN: merge-failed",
    );
    expect(deferredIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(deferredIdx);
  });

  it("renders a multi-action recipe as a numbered step list ending in the sentinel", () => {
    const out = render({
      status: "needs-human",
      reason: "merge-resolver-spawn-denied",
    });
    expect(out).toMatch(/^  1\. /m);
    const lines = out.split("\n").filter((l) => l !== "");
    expect(lines.at(-1)).toBe("NEEDS HUMAN: merge-resolver-spawn-denied");
  });

  it("renders a single-action recipe inline, never padded into a one-item list", () => {
    const out = render({
      status: "needs-human",
      reason: "flow-setup-upgrade-failed",
    });
    expect(out).toMatch(/^NEXT ACTION: Run flow install/m);
    expect(out).not.toMatch(/^  1\. /m);
  });

  it("every multi-line recipe is <non-numbered header> + 2-space-indented, contiguous, >=2-step numbered list", () => {
    // Guards the shape `pushNextAction` depends on (bin/flow-gate-summary.ts
    // ~100-104): the first line is a plain header (never itself numbered —
    // otherwise the header row and the numbered steps below it render with
    // inconsistent indentation), and every subsequent step is a 2-space
    // indented, contiguously-numbered line — never a one-item list (that
    // stays inline per carve-out 1), never a restarted/skipped ordinal.
    for (const [tag, recipe] of Object.entries(NEXT_ACTION_BY_REASON)) {
      if (!recipe.includes("\n")) continue;
      const [header, ...rest] = recipe.split("\n");
      expect(
        /^\s*\d+\.\s/.test(header),
        `${tag}: header must not be numbered`,
      ).toBe(false);
      const steps = rest.filter((l) => !/^\s{3,}- /.test(l));
      expect(
        steps.length,
        `${tag}: a numbered recipe needs >= 2 steps`,
      ).toBeGreaterThanOrEqual(2);
      steps.forEach((line, i) => {
        expect(line, `${tag} step ${i + 1}`).toMatch(
          new RegExp(`^  ${i + 1}\\. \\S`),
        );
      });
    }
  });

  it("places the task-tool-unavailable spawn-site suffix on the NEXT ACTION header, not the final step", () => {
    const out = render({
      status: "needs-human",
      reason: "task-tool-unavailable: pr-review-fix-applier",
    });
    const nextActionLine = out
      .split("\n")
      .find((l) => l.startsWith("NEXT ACTION:"))!;
    expect(nextActionLine).toContain("(spawn site: pr-review-fix-applier)");
    const lastLine = out
      .split("\n")
      .filter((l) => l !== "")
      .at(-2)!; // last step, before the sentinel
    expect(lastLine).not.toContain("(spawn site:");
  });
});

describe("render — awaiting-approval", () => {
  it("has no sentinel and ends with the two path bullets", () => {
    const out = render({
      status: "awaiting-approval",
      why: "plan ready for review (intent=feature)",
      worktree: "/a",
      planFile: "/a/p.md",
    });
    const lines = out.split("\n");
    expect(lines.slice(-2)).toEqual(["  - /a", "  - /a/p.md"]);
    expect(out).toContain("STATUS: AWAITING APPROVAL");
    expect(out).toContain("WHY: plan ready for review (intent=feature)");
    expect(out).toContain(
      "NEXT ACTION: reply approve / redirect <new direction> / cancel",
    );
    // Sentinel-line invariant does NOT apply here — these statuses are
    // pending checkpoints, not terminals. Assert the last char is not
    // trailing punctuation.
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith(".")).toBe(false);
    expect(out.endsWith(":")).toBe(false);
  });

  it("renders without worktree/planFile (degenerate input)", () => {
    const out = render({
      status: "awaiting-approval",
      why: "plan ready",
    });
    expect(out).toContain("STATUS: AWAITING APPROVAL");
    // No bullets, just the header rows.
    expect(out).not.toMatch(/^ {2}- /m);
  });

  it("renders only the worktree bullet when planFile omitted", () => {
    const out = render({
      status: "awaiting-approval",
      worktree: "/x",
    });
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toBe("  - /x");
  });

  it("--echo-prose prepends the delimited recap block above STATUS", () => {
    const out = render({
      status: "awaiting-approval",
      worktree: "/a",
      planFile: "/a/p.md",
      echoProse: true,
    });
    expect(out.startsWith("<!-- flow-echo-recap:start -->")).toBe(true);
    const startIdx = out.indexOf("<!-- flow-echo-recap:start -->");
    const endIdx = out.indexOf("<!-- flow-echo-recap:end -->");
    const statusIdx = out.indexOf("STATUS: AWAITING APPROVAL");
    expect(startIdx).toBe(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(statusIdx).toBeGreaterThan(endIdx);
    // The plan-file bullet inside the recap carries no trailing punctuation.
    const recapPlan = out
      .split("\n")
      .find((l) => l.startsWith("- Plan file:"))!;
    expect(recapPlan).toBe("- Plan file: /a/p.md");
    expect(recapPlan.endsWith(".")).toBe(false);
    expect(recapPlan.endsWith(":")).toBe(false);
    // The original two path bullets still close the block.
    const lines = out.split("\n");
    expect(lines.slice(-2)).toEqual(["  - /a", "  - /a/p.md"]);
  });

  it("--echo-prose without planFile renders the recap with `none`", () => {
    const out = render({
      status: "awaiting-approval",
      worktree: "/x",
      echoProse: true,
    });
    expect(out).toContain("- Plan file: none");
  });
});

describe("render — cancelled", () => {
  it("includes STATUS, WHY, NEXT ACTION, sentinel", () => {
    const out = render({
      status: "cancelled",
      why: "user cancelled at plan-pending-review",
    });
    expect(out).toBe(
      [
        "STATUS: CANCELLED",
        "WHY: user cancelled at plan-pending-review",
        "NEXT ACTION: none",
        "cancelled",
      ].join("\n"),
    );
    expect(finalLine(out)).toBe("cancelled");
  });

  it("renders without WHY when omitted", () => {
    const out = render({ status: "cancelled" });
    expect(out).toBe(
      ["STATUS: CANCELLED", "NEXT ACTION: none", "cancelled"].join("\n"),
    );
    expect(finalLine(out)).toBe("cancelled");
  });
});

describe("universal sentinel invariant", () => {
  const sentinelCases: Array<{
    name: string;
    input: Parameters<typeof render>[0];
    expected: string;
  }> = [
    {
      name: "merged sentinel byte-exact",
      input: { status: "merged", prUrl: "https://example/pr/1" },
      expected: "MERGED",
    },
    {
      name: "gated sentinel includes URL",
      input: {
        status: "gated",
        prUrl: "https://example/pr/1",
        validationItems: ["x"],
      },
      expected: "GATED: https://example/pr/1",
    },
    {
      name: "needs-human sentinel includes reason tag",
      input: { status: "needs-human", reason: "verify-exhausted" },
      expected: "NEEDS HUMAN: verify-exhausted",
    },
    {
      name: "cancelled sentinel is literal",
      input: { status: "cancelled", why: "user cancelled" },
      expected: "cancelled",
    },
  ];
  for (const c of sentinelCases) {
    it(c.name, () => {
      const out = render(c.input);
      expect(finalLine(out)).toBe(c.expected);
      // No trailing whitespace, no trailing newline counted in the
      // assertion: the final character of stdout is the last non-empty
      // line's last char.
      expect(out.endsWith("\n")).toBe(false);
      expect(out.endsWith(" ")).toBe(false);
      expect(out.endsWith("\t")).toBe(false);
    });

    it(`${c.name} — --echo-prose is a strict no-op`, () => {
      const without = render(c.input);
      const withFlag = render({ ...c.input, echoProse: true });
      // --echo-prose fires ONLY on awaiting-approval; the four sentinel
      // statuses are byte-for-byte identical with or without the flag, and
      // their final line is still the exact sentinel.
      expect(withFlag).toBe(without);
      expect(withFlag).not.toContain("flow-echo-recap");
      expect(finalLine(withFlag)).toBe(c.expected);
    });

    it(`${c.name} — --cleanup keeps the sentinel byte-exact final line`, () => {
      const cleanup: CleanupInput = {
        kind: "record",
        record: {
          at: "2026-01-01T00:00:00.000Z",
          status: "ok",
          summary: "no live processes",
          ran: true,
        },
      };
      const withCleanup = render({ ...c.input, cleanup });
      expect(finalLine(withCleanup)).toBe(c.expected);
      expect(withCleanup).toContain("CLEANUP: reap ok");
    });
  }

  it("awaiting-approval — --cleanup is a strict no-op", () => {
    const base = {
      status: "awaiting-approval" as const,
      why: "plan ready for review",
    };
    const without = render(base);
    const cleanup: CleanupInput = {
      kind: "record",
      record: {
        at: "2026-01-01T00:00:00.000Z",
        status: "ok",
        summary: "no live processes",
        ran: true,
      },
    };
    const withCleanup = render({ ...base, cleanup });
    // renderAwaitingApproval never reads inputs.cleanup — mirrors
    // --echo-prose's own no-op discipline on the other four statuses.
    expect(withCleanup).toBe(without);
    expect(withCleanup).not.toContain("CLEANUP");
  });
});

describe("renderCleanup", () => {
  it("pins the ok-record line", () => {
    expect(
      renderCleanup({
        kind: "record",
        record: {
          at: "2026-01-01T00:00:00.000Z",
          status: "ok",
          summary: "no live processes",
          ran: true,
        },
      }),
    ).toEqual([
      "CLEANUP: reap ok — no live processes (recorded 2026-01-01T00:00:00.000Z)",
    ]);
  });

  it("pins the unclean-record line plus its re-run follow-on", () => {
    expect(
      renderCleanup({
        kind: "record",
        record: {
          at: "2026-01-01T00:00:00.000Z",
          status: "unclean",
          summary: "1 still-alive process",
          ran: true,
          problems: ["registry: still-alive=1"],
        },
      }),
    ).toEqual([
      "CLEANUP: REAP UNCLEAN — 1 still-alive process (recorded 2026-01-01T00:00:00.000Z)",
      "  - re-run: flow-browser-teardown --reap --dry-run",
    ]);
  });

  it("pins the missing-record line plus its re-run follow-on", () => {
    expect(renderCleanup({ kind: "missing-record" })).toEqual([
      "CLEANUP: REAP NOT RECORDED — the terminal-state reap did not run; spawned processes may still be alive",
      "  - re-run: flow-browser-teardown --reap --dry-run",
    ]);
  });

  it("pins the stale line plus its re-run follow-on", () => {
    expect(
      renderCleanup({
        kind: "stale",
        record: {
          at: "2025-12-31T00:00:00.000Z",
          status: "ok",
          summary: "no live processes",
          ran: true,
        },
      }),
    ).toEqual([
      "CLEANUP: REAP NOT RECORDED (stale) — this render's reap did not run; the record shown is from an earlier attempt (2025-12-31T00:00:00.000Z)",
      "  - re-run: flow-browser-teardown --reap --dry-run",
    ]);
  });

  it("pins the no-state line with no follow-on", () => {
    expect(renderCleanup({ kind: "no-state" })).toEqual([
      "CLEANUP: unknown — no pipeline state file for this run",
    ]);
  });
});

describe("parseArgs", () => {
  it("accepts every documented flag", () => {
    const args = parseArgs([
      "--status",
      "gated",
      "--pr-url",
      "https://example/pr/1",
      "--why",
      "2 items",
      "--reason",
      "ignored-for-gated",
      "--validation-items-file",
      "/tmp/nonexistent",
      "--deferred-file",
      "/tmp/nonexistent2",
      "--worktree",
      "/w",
      "--plan-file",
      "/w/p.md",
    ]);
    expect("error" in args).toBe(false);
    if ("error" in args) return;
    expect(args.status).toBe("gated");
    expect(args.prUrl).toBe("https://example/pr/1");
    expect(args.why).toBe("2 items");
    expect(args.reason).toBe("ignored-for-gated");
    expect(args.validationItemsFile).toBe("/tmp/nonexistent");
    expect(args.deferredFile).toBe("/tmp/nonexistent2");
    expect(args.worktree).toBe("/w");
    expect(args.planFile).toBe("/w/p.md");
  });

  it("rejects an unknown --status value", () => {
    const r = parseArgs(["--status", "bogus"]);
    expect(r).toHaveProperty("error");
  });

  it("rejects an unknown flag", () => {
    const r = parseArgs(["--status", "merged", "--bogus", "x"]);
    expect(r).toHaveProperty("error");
  });

  it("requires --status", () => {
    const r = parseArgs([]);
    expect(r).toHaveProperty("error");
  });

  it("rejects a flag with no value", () => {
    const r = parseArgs(["--status", "merged", "--pr-url"]);
    expect(r).toHaveProperty("error");
  });

  it("accepts --validation-items-file pointing at a nonexistent path (suppression deferred to render)", () => {
    const r = parseArgs([
      "--status",
      "gated",
      "--validation-items-file",
      "/definitely/does/not/exist",
    ]);
    expect("error" in r).toBe(false);
  });

  it("--cleanup is a boolean flag with no value, same shape as --echo-prose", () => {
    const r = parseArgs(["--status", "merged", "--cleanup"]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.cleanup).toBe(true);
  });
});

describe("run (end-to-end CLI)", () => {
  it("writes a gated block to stdout and returns 0", () => {
    const itemsPath = path.join(tmpRoot, "items.txt");
    fs.writeFileSync(itemsPath, "- one\n- two\n");
    // Capture stdout by hijacking process.stdout.write briefly.
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = run([
        "--status",
        "gated",
        "--pr-url",
        "https://example/pr/1",
        "--why",
        "2 items remain",
        "--validation-items-file",
        itemsPath,
      ]);
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const lines = captured.split("\n").filter((l) => l !== "");
    expect(lines[0]).toBe("STATUS: GATED");
    expect(lines[lines.length - 1]).toBe("GATED: https://example/pr/1");
  });

  it("silently suppresses FOLLOW-UPS when deferred file is missing on disk", () => {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = run([
        "--status",
        "merged",
        "--pr-url",
        "https://example/pr/1",
        "--deferred-file",
        "/this/path/does/not/exist.txt",
      ]);
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(captured).not.toContain("FOLLOW-UPS");
    expect(captured.trimEnd().endsWith("MERGED")).toBe(true);
  });

  it("silently suppresses FOLLOW-UPS when deferred file is empty", () => {
    const emptyPath = path.join(tmpRoot, "empty.txt");
    fs.writeFileSync(emptyPath, "");
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      run([
        "--status",
        "merged",
        "--pr-url",
        "https://example/pr/1",
        "--deferred-file",
        emptyPath,
      ]);
    } finally {
      process.stdout.write = original;
    }
    expect(captured).not.toContain("FOLLOW-UPS");
  });

  // Symmetry with the two deferred-file suppression tests above:
  // --validation-items-file shares the same readFileOrEmpty +
  // parseValidationItems suppression contract, so a missing-on-disk
  // path and an empty file must both produce zero bulleted items.
  it("silently suppresses validation bullets when validation-items file is missing on disk", () => {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = run([
        "--status",
        "gated",
        "--pr-url",
        "https://example/pr/1",
        "--validation-items-file",
        "/this/path/does/not/exist.txt",
      ]);
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    // No bulleted item lines (matching the "  - " prefix the gated
    // branch uses for validation items).
    const bullets = captured.split("\n").filter((l) => l.startsWith("  - "));
    expect(bullets).toEqual([]);
    expect(captured.trimEnd().endsWith("GATED: https://example/pr/1")).toBe(
      true,
    );
  });

  it("silently suppresses validation bullets when validation-items file is empty", () => {
    const emptyPath = path.join(tmpRoot, "empty-items.txt");
    fs.writeFileSync(emptyPath, "");
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = run([
        "--status",
        "gated",
        "--pr-url",
        "https://example/pr/1",
        "--validation-items-file",
        emptyPath,
      ]);
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const bullets = captured.split("\n").filter((l) => l.startsWith("  - "));
    expect(bullets).toEqual([]);
  });

  it("returns 2 on bad args", () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const rc = run(["--status", "bogus"]);
      expect(rc).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(captured).toContain("flow-gate-summary:");
    expect(captured).toContain("usage:");
  });

  function captureStdout(fn: () => number): { rc: number; out: string } {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = fn();
      return { rc, out: captured };
    } finally {
      process.stdout.write = original;
    }
  }

  function seedState(slug: string, overrides: Partial<PipelineState> = {}) {
    writeState(
      {
        slug,
        phase: "merged",
        repo: "/tmp/repo",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
      tmpRoot,
    );
  }

  it("omits CLEANUP entirely when --cleanup is not passed, even with a recorded reap", () => {
    seedState("cleanup-flag-off-slug", {
      reap: {
        at: "2026-01-01T00:05:00.000Z",
        status: "ok",
        summary: "no live processes",
        ran: true,
      },
    });
    const { rc, out } = captureStdout(() =>
      run(["--status", "merged"], {
        env: { FLOW_SLUG: "cleanup-flag-off-slug" },
        stateDir: tmpRoot,
      }),
    );
    expect(rc).toBe(0);
    expect(out).not.toContain("CLEANUP");
  });

  it("--cleanup renders a fresh record when reap.at is newer than updatedAt", () => {
    seedState("cleanup-fresh-slug", {
      reap: {
        at: "2026-01-01T00:05:00.000Z",
        status: "ok",
        summary: "no live processes",
        ran: true,
      },
    });
    const { rc, out } = captureStdout(() =>
      run(["--status", "merged", "--cleanup"], {
        env: { FLOW_SLUG: "cleanup-fresh-slug" },
        stateDir: tmpRoot,
      }),
    );
    expect(rc).toBe(0);
    expect(out).toContain("CLEANUP: reap ok — no live processes");
    expect(out).not.toContain("stale");
  });

  it("--cleanup renders the stale line when reap.at predates updatedAt", () => {
    seedState("cleanup-stale-slug", {
      updatedAt: "2026-01-02T00:00:00.000Z",
      reap: {
        at: "2026-01-01T00:00:00.000Z",
        status: "ok",
        summary: "no live processes",
        ran: true,
      },
    });
    const { rc, out } = captureStdout(() =>
      run(["--status", "merged", "--cleanup"], {
        env: { FLOW_SLUG: "cleanup-stale-slug" },
        stateDir: tmpRoot,
      }),
    );
    expect(rc).toBe(0);
    expect(out).toContain("CLEANUP: REAP NOT RECORDED (stale)");
  });

  it("degrades to fresh (never a false stale alarm) when either timestamp is unparseable", () => {
    seedState("cleanup-badtime-slug", {
      updatedAt: "not-a-real-date",
      reap: {
        at: "2026-01-01T00:00:00.000Z",
        status: "ok",
        summary: "no live processes",
        ran: true,
      },
    });
    const { rc, out } = captureStdout(() =>
      run(["--status", "merged", "--cleanup"], {
        env: { FLOW_SLUG: "cleanup-badtime-slug" },
        stateDir: tmpRoot,
      }),
    );
    expect(rc).toBe(0);
    expect(out).toContain("CLEANUP: reap ok");
    expect(out).not.toContain("stale");
  });

  it("--cleanup renders unknown when no state file exists for the resolved slug", () => {
    const { rc, out } = captureStdout(() =>
      run(["--status", "merged", "--cleanup"], {
        env: { FLOW_SLUG: "cleanup-missing-slug" },
        stateDir: tmpRoot,
      }),
    );
    expect(rc).toBe(0);
    expect(out).toContain(
      "CLEANUP: unknown — no pipeline state file for this run",
    );
  });

  it("--cleanup renders REAP NOT RECORDED when state exists but carries no reap field", () => {
    seedState("cleanup-norecord-slug");
    const { rc, out } = captureStdout(() =>
      run(["--status", "merged", "--cleanup"], {
        env: { FLOW_SLUG: "cleanup-norecord-slug" },
        stateDir: tmpRoot,
      }),
    );
    expect(rc).toBe(0);
    expect(out).toContain(
      "CLEANUP: REAP NOT RECORDED — the terminal-state reap did not run",
    );
  });
});
