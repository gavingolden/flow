import { describe, expect, it } from "vitest";
import {
  renderRequestEcho,
  runShapingFlags,
  REQUEST_ECHO_START,
  REQUEST_ECHO_END,
} from "./request-echo";
import type { PipelineState } from "./state";

function baseState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "csv-export",
    phase: "implementing",
    repo: "/work/flow",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

describe(renderRequestEcho, () => {
  it("keeps a multi-line request body byte-identical when rendered", () => {
    const body = "line one\nline two\n\nline four with trailing spaces   ";
    const out = renderRequestEcho(baseState(), body);
    expect(out.endsWith(`\n${body}\n${REQUEST_ECHO_END}`)).toBe(true);
  });

  it("keeps a body containing triple backticks byte-identical when rendered", () => {
    const body = "```js\nconsole.log('hi');\n```";
    const out = renderRequestEcho(baseState(), body);
    expect(out.includes(`\n${body}\n${REQUEST_ECHO_END}`)).toBe(true);
  });

  it("keeps a body containing the marker strings themselves byte-identical when rendered, and still emits both markers", () => {
    const body = `it says ${REQUEST_ECHO_START} and ${REQUEST_ECHO_END} literally`;
    const out = renderRequestEcho(baseState(), body);
    const lines = out.split("\n");
    expect(lines[0]).toBe(REQUEST_ECHO_START);
    expect(lines[lines.length - 1]).toBe(REQUEST_ECHO_END);
    expect(out.includes(`\n${body}\n${REQUEST_ECHO_END}`)).toBe(true);
  });

  it("does not truncate a several-thousand-character body when rendered", () => {
    const body = "x".repeat(5000);
    const out = renderRequestEcho(baseState(), body);
    expect(out).toContain(body);
  });

  it("renders `flags: none` when every run-shaping field is at its default", () => {
    const out = renderRequestEcho(baseState(), "req");
    const header = out.split("\n")[1];
    expect(header).toContain("flags: none");
  });

  it("prefixes the flag list with `flags: ` when run-shaping fields are non-default", () => {
    const state = baseState({ launcher: "tmux", forceResearch: true });
    const header = renderRequestEcho(state, "body").split("\n")[1];
    expect(header).toContain("flags: --research --tmux");
  });

  it.each([
    [{ autoMerge: false }, "--no-auto-merge"],
    [{ waitForCopilot: true }, "--wait-for-copilot"],
    [{ forceResearch: true }, "--research"],
    [{ copilotReview: "always" as const }, "--copilot-review always"],
    [{ launcher: "tmux" as const }, "--tmux"],
    [{ model: "opus" as const }, "--model opus"],
    [{ effort: "high" as const }, "--effort high"],
  ])(
    "renders each non-default run-shaping flag exactly once (%j)",
    (overrides, expectedFlag) => {
      const flags = runShapingFlags(baseState(overrides));
      const occurrences = flags.filter((f) => f === expectedFlag);
      expect(occurrences).toHaveLength(1);
    },
  );

  it("omits per-phase model overrides and interviewMode from the header", () => {
    const state = baseState({
      modelPlanning: "opus",
      modelImplement: "haiku",
      interviewMode: "force",
    });
    const flags = runShapingFlags(state);
    expect(flags).toEqual([]);
    const out = renderRequestEcho(state, "req");
    expect(out).not.toContain("modelPlanning");
    expect(out).not.toContain("opus");
    expect(out).not.toContain("interviewMode");
  });

  it("renders the slug and repo in the header line", () => {
    const out = renderRequestEcho(baseState(), "req");
    const header = out.split("\n")[1];
    expect(header).toContain("slug: csv-export");
    expect(header).toContain("repo:");
    expect(header).toContain("/work/flow");
  });
});
