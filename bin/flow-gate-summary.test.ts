import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NEXT_ACTION,
  NEXT_ACTION_BY_REASON,
  parseArgs,
  render,
  run,
} from "./flow-gate-summary";

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
  return rendered.split("\n").filter((l) => l !== "").pop() ?? "";
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
      deferredBlock: "LOCAL FOLLOW-UPS: 1 ran\n\n  RAN     flow setup --upgrade  (exit 0)",
    });
    expect(out).toContain("DEFERRED:");
    expect(out).toContain("  LOCAL FOLLOW-UPS: 1 ran");
    expect(out).toContain("  RAN     flow setup --upgrade  (exit 0)");
    expect(finalLine(out)).toBe("MERGED");
  });

  it("suppresses DEFERRED when deferredBlock is empty", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      deferredBlock: "",
    });
    expect(out).not.toContain("DEFERRED");
    expect(finalLine(out)).toBe("MERGED");
  });

  it("suppresses DEFERRED when deferredBlock is whitespace-only", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
      deferredBlock: "   \n\n",
    });
    expect(out).not.toContain("DEFERRED");
  });

  it("suppresses DEFERRED when deferredBlock is undefined", () => {
    const out = render({
      status: "merged",
      prUrl: "https://example/pr/1",
    });
    expect(out).not.toContain("DEFERRED");
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
    expect(out).toContain("NEXT ACTION: validate then run: gh pr merge --squash 142");
    expect(out).toContain("  - Open /portfolio with the seeded user — chart renders");
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
    expect(out).toContain("NEXT ACTION: validate then run: gh pr merge --squash 1");
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
    expect(out).toContain("NEXT ACTION: validate then run: gh pr merge --squash <pr>");
    expect(finalLine(out)).toBe("GATED:");
  });

  it("embeds DEFERRED when non-empty", () => {
    const out = render({
      status: "gated",
      prUrl: "https://example/pr/1",
      validationItems: ["one"],
      deferredBlock: "LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed",
    });
    expect(out).toContain("DEFERRED:");
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
    expect(out).toContain(
      `NEXT ACTION: ${NEXT_ACTION_BY_REASON["task-tool-unavailable"]}`,
    );
    expect(finalLine(out)).toBe("NEEDS HUMAN: task-tool-unavailable: pr-review-fix-applier");
    expect(out).toContain("WHY: task-tool-unavailable: pr-review-fix-applier");
  });

  it("renders PR URL when provided alongside reason", () => {
    const out = render({
      status: "needs-human",
      reason: "pr-closed-without-merge",
      prUrl: "https://example/pr/9",
    });
    expect(out).toContain("PR: https://example/pr/9");
    expect(out).toContain(`NEXT ACTION: ${NEXT_ACTION_BY_REASON["pr-closed-without-merge"]}`);
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

  it("renders DEFERRED block before the sentinel", () => {
    const out = render({
      status: "needs-human",
      reason: "merge-failed",
      why: "rebase conflict in src/foo.ts",
      deferredBlock: "LOCAL FOLLOW-UPS (deferred — PR not yet merged): 0 ran, 1 noted, 0 failed",
    });
    const lines = out.split("\n");
    const deferredIdx = lines.findIndex((l) => l === "DEFERRED:");
    const sentinelIdx = lines.findIndex((l) => l === "NEEDS HUMAN: merge-failed");
    expect(deferredIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(deferredIdx);
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
  const sentinelCases: Array<{ name: string; input: Parameters<typeof render>[0]; expected: string }> = [
    {
      name: "merged sentinel byte-exact",
      input: { status: "merged", prUrl: "https://example/pr/1" },
      expected: "MERGED",
    },
    {
      name: "gated sentinel includes URL",
      input: { status: "gated", prUrl: "https://example/pr/1", validationItems: ["x"] },
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
  }
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

  it("silently suppresses DEFERRED when deferred file is missing on disk", () => {
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
    expect(captured).not.toContain("DEFERRED");
    expect(captured.trimEnd().endsWith("MERGED")).toBe(true);
  });

  it("silently suppresses DEFERRED when deferred file is empty", () => {
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
    expect(captured).not.toContain("DEFERRED");
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
});
