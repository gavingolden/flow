import { describe, expect, it } from "vitest";
import {
  renderEchoRecap,
  ECHO_RECAP_START,
  ECHO_RECAP_END,
} from "./echo-recap";

describe(renderEchoRecap, () => {
  it("bounds the block with the start and end markers", () => {
    const out = renderEchoRecap({});
    const lines = out.split("\n");
    expect(lines[0]).toBe(ECHO_RECAP_START);
    expect(lines[lines.length - 1]).toBe(ECHO_RECAP_END);
    expect(lines[0]).toBe("<!-- flow-echo-recap:start -->");
    expect(lines[lines.length - 1]).toBe("<!-- flow-echo-recap:end -->");
  });

  it("renders every bounded field label", () => {
    const out = renderEchoRecap({});
    for (const label of [
      "- PR URL:",
      "- Plan file:",
      "- branch:",
      "- PR title:",
      "- Phase:",
      "- CI:",
      "- Review:",
      "- Follow-ups:",
    ]) {
      expect(out).toContain(label);
    }
  });

  it("renders `none` for every absent scalar", () => {
    const out = renderEchoRecap({});
    expect(out).toContain("- PR URL: none");
    expect(out).toContain("- Plan file: none");
    expect(out).toContain("- branch: none (PR #none)");
    expect(out).toContain("- PR title: none");
    expect(out).toContain("- Phase: none");
    expect(out).toContain("- CI: none");
    expect(out).toContain("- Review: none (none findings)");
    expect(out).toContain("- Follow-ups: none");
  });

  it("renders a count of 0 as `0`, not `none`", () => {
    const out = renderEchoRecap({ findingCount: 0, followupCount: 0 });
    expect(out).toContain("- Review: none (0 findings)");
    expect(out).toContain("- Follow-ups: 0");
  });

  it("gives the PR-URL and plan-file bullets no trailing punctuation", () => {
    const out = renderEchoRecap({
      prUrl: "https://github.com/org/repo/pull/42",
      planFile: "/work/.flow-tmp/plan.md",
    });
    const lines = out.split("\n");
    const prLine = lines.find((l) => l.startsWith("- PR URL:"))!;
    const planLine = lines.find((l) => l.startsWith("- Plan file:"))!;
    for (const line of [prLine, planLine]) {
      expect(line.endsWith(".")).toBe(false);
      expect(line.endsWith(":")).toBe(false);
      expect(line.endsWith(",")).toBe(false);
      expect(line.endsWith(" ")).toBe(false);
    }
    expect(prLine).toBe("- PR URL: https://github.com/org/repo/pull/42");
    expect(planLine).toBe("- Plan file: /work/.flow-tmp/plan.md");
  });

  it("renders every field when fully populated", () => {
    const out = renderEchoRecap({
      prUrl: "https://github.com/org/repo/pull/42",
      planFile: "/work/.flow-tmp/plan.md",
      branch: "feat/echo-recap",
      prNumber: "42",
      prTitle: "Add echo recap",
      phase: "merged",
      ciVerdict: "proceed-to-review",
      reviewVerdict: "clean",
      findingCount: 3,
      followupCount: 1,
    });
    expect(out).toContain("- PR URL: https://github.com/org/repo/pull/42");
    expect(out).toContain("- Plan file: /work/.flow-tmp/plan.md");
    expect(out).toContain("- branch: feat/echo-recap (PR #42)");
    expect(out).toContain("- PR title: Add echo recap");
    expect(out).toContain("- Phase: merged");
    expect(out).toContain("- CI: proceed-to-review");
    expect(out).toContain("- Review: clean (3 findings)");
    expect(out).toContain("- Follow-ups: 1");
  });
});
