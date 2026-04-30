import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoopLogger } from "../../util/logger.js";
import type { Task } from "../../state/task-file.js";
import { buildPlanPrompt, summarizePlanOutputs } from "./plan.js";

function makeTask(body: string): Task {
  return {
    path: "/tmp/task-x.md",
    frontmatter: {
      id: "2026-04-30-x",
      status: "planning",
      created: "2026-04-30T00:00:00.000Z",
      updated: "2026-04-30T00:00:00.000Z",
      target_repo: "/repo",
      worktree: "/repo/wt",
      branch: "agent/x",
      pr: null,
      manual_validation: null,
      merge_commit: null,
    },
    body,
  };
}

const BASE_BODY = [
  "## User prompt",
  "",
  "do the thing",
  "",
  "## Triage",
  "",
  "- intent: feature",
  "- summary: x",
  "",
].join("\n");

describe("buildPlanPrompt", () => {
  it("includes the BLOCKED.md escape-hatch instruction", () => {
    const prompt = buildPlanPrompt(makeTask(BASE_BODY), "/tmp/plan");
    expect(prompt).toContain("/tmp/plan/BLOCKED.md");
    expect(prompt).toMatch(/Escape hatch/);
  });

  it("does not emit a REVISION NOTES block when ## Revision notes is absent", () => {
    const prompt = buildPlanPrompt(makeTask(BASE_BODY), "/tmp/plan");
    expect(prompt).not.toContain("REVISION NOTES");
  });

  it("threads the latest revision-notes entry into a dedicated REVISION NOTES block", () => {
    const body = `${BASE_BODY}
## Revision notes

- 2026-04-30T10:00:00.000Z: use the FRED quarterly endpoint
`;
    const prompt = buildPlanPrompt(makeTask(body), "/tmp/plan");
    expect(prompt).toContain("REVISION NOTES");
    expect(prompt).toContain("use the FRED quarterly endpoint");
  });

  it("emits only the latest entry when multiple revision-notes entries exist", () => {
    const body = `${BASE_BODY}
## Revision notes

- 2026-04-30T10:00:00.000Z: first redirection (older)
- 2026-04-30T11:00:00.000Z: second redirection — use the daily endpoint
`;
    const prompt = buildPlanPrompt(makeTask(body), "/tmp/plan");
    expect(prompt).toContain("second redirection — use the daily endpoint");
    expect(prompt).not.toContain("first redirection (older)");
  });

  it("keeps the existing PRIOR ATTEMPT FAILED slot distinct from REVISION NOTES", () => {
    const body = `${BASE_BODY}
## Revision notes

- 2026-04-30T10:00:00.000Z: redirection text
`;
    const prompt = buildPlanPrompt(
      makeTask(body),
      "/tmp/plan",
      "synthetic failure",
    );
    expect(prompt).toContain("PRIOR ATTEMPT FAILED");
    expect(prompt).toContain("synthetic failure");
    expect(prompt).toContain("REVISION NOTES");
    expect(prompt).toContain("redirection text");
  });
});

describe("summarizePlanOutputs", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-plan-summary-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns blocked=false and the standard checklist when BLOCKED.md is absent", async () => {
    await fs.writeFile(path.join(tmp, "prd.md"), "x");
    await fs.writeFile(path.join(tmp, "task-breakdown.md"), "x");
    await fs.writeFile(path.join(tmp, "pr-description-draft.md"), "x");
    const summary = await summarizePlanOutputs(tmp, NoopLogger);
    expect(summary.blocked).toBe(false);
    expect(summary.text).toContain("prd.md: present");
    expect(summary.text).toContain("task-breakdown.md: present");
    expect(summary.text).toContain("pr-description-draft.md: present");
    expect(summary.text).not.toContain("BLOCKED");
  });

  it("returns blocked=true and surfaces BLOCKED.md content when present", async () => {
    await fs.writeFile(
      path.join(tmp, "BLOCKED.md"),
      "Question 1: which API endpoint should we use?\nQuestion 2: how should errors be handled?",
    );
    const summary = await summarizePlanOutputs(tmp, NoopLogger);
    expect(summary.blocked).toBe(true);
    expect(summary.text).toContain("BLOCKED:");
    expect(summary.text).toContain("Question 1: which API endpoint");
    expect(summary.text).toContain("Question 2: how should errors be handled?");
  });
});
