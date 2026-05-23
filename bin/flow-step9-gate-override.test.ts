/**
 * Regression-pins the /flow-pipeline step 9 gate-override live-re-query
 * contract that the supervisor prose now depends on.
 *
 * The supervisor's step 9 "Gate override (post-verdict, opt-in)" sub-step
 * runs `flow-gate-decide "$PR"` BEFORE deciding fire-form vs refuse-form.
 * The verdict in the supervisor's local context may be stale: between the
 * GATED render and the user's merge instruction, the user can tick `- [ ]`
 * boxes in the PR body and clear the gate themselves. Without the re-query,
 * the supervisor refuses an override that isn't needed — re-rendering a
 * verdict that no longer holds.
 *
 * These tests pin the two branches the supervisor depends on:
 *   - body with unchecked items → decision=gated → supervisor fires the
 *     AskUserQuestion confirmation form.
 *   - body with zero unchecked items (user cleared the gate themselves) →
 *     decision=auto-merge → supervisor skips the form and routes to step
 *     10's auto-merge path (flow-merge-guard re-confirms from live body).
 *
 * Pinned both at the pure `decide()` boundary (no gh round-trip) and end-
 * to-end through the public `run()` entry with a mocked `gh` so the same
 * PR-body content drives the same decision through the helper consumers
 * use on the supervisor's tmux PATH.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decide, run, type DecisionResult } from "./flow-gate-decide";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-step9-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seedState(slug: string): void {
  fs.writeFileSync(
    path.join(stateDir, `${slug}.json`),
    JSON.stringify({
      slug,
      phase: "gating",
      repo: "/tmp/repo",
      updatedAt: "2026-05-22T11:00:00Z",
    }) + "\n",
  );
}

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    writes.push(s.toString());
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

function ghBody(body: string, state = "OPEN") {
  return vi.fn(() => ({
    stdout: JSON.stringify({ body, state, url: "https://x/y/pull/5" }),
    stderr: "",
    exitCode: 0,
  }));
}

const HAS_UNCHECKED =
  "## Test Steps\n\n- [ ] Hover the legend entry — the popover opens\n- [ ] Run `npm run verify`\n";
const ALL_CHECKED = "## Test Steps\n\n- [x] Run `npm run verify` — pass\n";
const MISSING_HEADING = "## Why\n\nbecause.\n";
const MIXED_CHECKED_UNCHECKED =
  "## Test Steps\n\n- [x] Run `npm run verify` — pass\n- [ ] Hover the legend entry — the popover opens\n- [x] Run `npm run test`\n- [ ] Manually inspect the rendered chart\n";

describe("step 9 gate-override live re-query (pure decide())", () => {
  it("returns decision=gated when the live body has unchecked items — supervisor fires the AskUserQuestion form", () => {
    const r = decide({
      body: HAS_UNCHECKED,
      state: "OPEN",
      url: "https://x/y/pull/5",
      autoMerge: true,
    });
    expect(r.decision).toBe("gated");
    expect(r.validationItems).toEqual([
      "Hover the legend entry — the popover opens",
      "Run `npm run verify`",
    ]);
  });

  it("returns decision=auto-merge when the user cleared the gate (all items checked) — supervisor skips the form and routes to step 10's auto-merge path", () => {
    const r = decide({
      body: ALL_CHECKED,
      state: "OPEN",
      url: "https://x/y/pull/5",
      autoMerge: true,
    });
    expect(r.decision).toBe("auto-merge");
    expect(r.validationItems ?? []).toEqual([]);
  });

  it("returns decision=escalate-heading-missing on a body without `## Test Steps` — supervisor's step 0 must NOT short-circuit to auto-merge on missing heading", () => {
    // Pins the negative space the step-0 short-circuit must NOT cover:
    // a body that lacks `## Test Steps` routes to escalate-heading-missing,
    // which the SKILL.md/redirect-handling.md case-statement sends to step
    // 9's main decision table (NOT the override-skip path that auto-merge
    // takes). A regression that mis-routed missing-heading to the override
    // skip would silently merge a PR with no Test Steps section at all.
    const r = decide({
      body: MISSING_HEADING,
      state: "OPEN",
      url: "https://x/y/pull/5",
      autoMerge: true,
    });
    expect(r.decision).toBe("escalate-heading-missing");
  });

  it("returns decision=gated with only the unchecked items on a mixed checked/unchecked body — the realistic user-progress shape", () => {
    // Pins the most realistic real-world shape: the user has ticked some
    // boxes but not all. The verdict stays gated and validationItems
    // surfaces ONLY the still-unchecked items (the already-checked ones
    // drop out of the supervisor's surfaced count for the override form).
    const r = decide({
      body: MIXED_CHECKED_UNCHECKED,
      state: "OPEN",
      url: "https://x/y/pull/5",
      autoMerge: true,
    });
    expect(r.decision).toBe("gated");
    expect(r.validationItems).toEqual([
      "Hover the legend entry — the popover opens",
      "Manually inspect the rendered chart",
    ]);
  });
});

describe("step 9 gate-override live re-query (end-to-end run())", () => {
  it("end-to-end: still-gated body → run() exits 0 with decision=gated (supervisor fires form)", () => {
    seedState("still-gated");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "still-gated"], {
      gh: ghBody(HAS_UNCHECKED),
      stateDir,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.writes.join("")) as DecisionResult;
    expect(result.decision).toBe("gated");
  });

  it("end-to-end: cleared-gate body → run() exits 0 with decision=auto-merge (supervisor skips form, routes to step 10)", () => {
    seedState("cleared-gate");
    const cap = captureStdout();
    const exit = run(["5", "--slug", "cleared-gate"], {
      gh: ghBody(ALL_CHECKED),
      stateDir,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.writes.join("")) as DecisionResult;
    expect(result.decision).toBe("auto-merge");
  });
});
