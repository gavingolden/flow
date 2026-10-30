import { describe, expect, it } from "vitest";
import {
  renderRequestEcho,
  renderRequestEchoMessage,
  requestEchoHeader,
  REQUEST_ECHO_MESSAGE_MAX_CHARS,
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
    const state = baseState({ forceResearch: true });
    const header = renderRequestEcho(state, "body").split("\n")[1];
    expect(header).toContain("flags: --research");
  });

  it.each([
    [{ autoMerge: false }, "--no-auto-merge"],
    [{ waitForCopilot: true }, "--wait-for-copilot"],
    [{ forceResearch: true }, "--research"],
    [{ copilotReview: "always" as const }, "--copilot-review always"],
    [{ model: "opus" as const }, "--model opus"],
    [{ effort: "high" as const }, "--effort high"],
    [
      { epic: { slug: "my-epic", featureId: "feature-a" } },
      "--epic my-epic/feature-a",
    ],
  ])(
    "renders each non-default run-shaping flag exactly once (%j)",
    (overrides, expectedFlag) => {
      const flags = runShapingFlags(baseState(overrides));
      const occurrences = flags.filter((f) => f === expectedFlag);
      expect(occurrences).toHaveLength(1);
    },
  );

  it.each([
    [{ autoMerge: true }],
    [{ launcher: "plain" as const }],
    [{ copilotReview: "auto" as const }],
  ])("renders NO flag for an explicit-default value (%j)", (overrides) => {
    const flags = runShapingFlags(baseState(overrides));
    expect(flags).toEqual([]);
  });

  it("does not render `launcher` as a `--tmux`/`--no-tmux` flag, only as an informational header field", () => {
    const state = baseState({ launcher: "tmux" });
    const flags = runShapingFlags(state);
    expect(flags).not.toContain("--tmux");
    expect(flags).not.toContain("--no-tmux");
    const header = renderRequestEcho(state, "body").split("\n")[1];
    expect(header).toContain("launcher: tmux");
  });

  it("omits the launcher header field when launcher is absent (legacy tmux-era state)", () => {
    const header = renderRequestEcho(baseState(), "req").split("\n")[1];
    expect(header).not.toContain("launcher:");
  });

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

const serialized = (m: string): number =>
  JSON.stringify({ systemMessage: m }).length;

describe(requestEchoHeader, () => {
  it("renders the same header line in plain and markdown link modes apart from the repo link", () => {
    const state = baseState({ launcher: "tmux", forceResearch: true });
    const plain = requestEchoHeader(state, "plain");
    expect(plain).toBe(
      "slug: csv-export | repo: /work/flow | flags: --research | launcher: tmux",
    );
    const markdown = requestEchoHeader(state, "markdown");
    expect(markdown).toContain("slug: csv-export | repo: ");
    expect(markdown).toContain("flags: --research | launcher: tmux");
    expect(renderRequestEcho(state, "b").split("\n")[1]).toBe(markdown);
  });
});

describe(renderRequestEchoMessage, () => {
  it("returns the header, a blank line, then the request verbatim", () => {
    const body = "line one\n```js\nx\n```\n  trailing   ";
    const out = renderRequestEchoMessage(baseState(), body);
    expect(out).toBe(`${requestEchoHeader(baseState(), "plain")}\n\n${body}`);
  });

  it("passes the marker strings through without adding any markers", () => {
    const body = `quotes ${REQUEST_ECHO_START} and ${REQUEST_ECHO_END}`;
    const out = renderRequestEchoMessage(baseState(), body);
    expect(out.endsWith(`\n\n${body}`)).toBe(true);
    expect(out.startsWith(REQUEST_ECHO_START)).toBe(false);
    expect(out.split(REQUEST_ECHO_START)).toHaveLength(2);
    expect(out.split(REQUEST_ECHO_END)).toHaveLength(2);
  });

  it("caps a 20,000-character body at 9,000 serialized characters and names `flow prompt <slug>`", () => {
    const out = renderRequestEchoMessage(baseState(), "y".repeat(20000));
    expect(serialized(out)).toBeLessThanOrEqual(REQUEST_ECHO_MESSAGE_MAX_CHARS);
    expect(out.startsWith(requestEchoHeader(baseState(), "plain"))).toBe(true);
    expect(out).toContain("of 20000 characters");
    expect(
      out.endsWith("run `flow prompt csv-export` for the full text]"),
    ).toBe(true);
  });

  it("counts JSON escaping against the cap for a 9,000-character body of short quoted lines", () => {
    const body = Array.from({ length: 2250 }, () => '"a"').join("\n") + "\n";
    expect(body).toHaveLength(9000);
    const out = renderRequestEchoMessage(baseState(), body);
    expect(serialized(out)).toBeLessThanOrEqual(REQUEST_ECHO_MESSAGE_MAX_CHARS);
    expect(out).toContain("[request truncated:");
  });

  it("does not truncate a body whose serialized message fits exactly", () => {
    const state = baseState();
    const overhead = serialized(renderRequestEchoMessage(state, ""));
    const out = renderRequestEchoMessage(state, "z".repeat(9000 - overhead));
    expect(serialized(out)).toBe(9000);
    expect(out).not.toContain("[request truncated:");
  });

  it("never splits a surrogate pair at the cut boundary", () => {
    const emoji = "\u{1F600}";
    const out = renderRequestEchoMessage(baseState(), emoji.repeat(5000), 600);
    expect(serialized(out)).toBeLessThanOrEqual(600);
    const kept = out.split("\n\n")[1]!;
    expect(kept).toMatch(/^(\u{1F600})+$/u);
    for (let i = 0; i < kept.length; i++) {
      const c = kept.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = kept.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        expect(c >= 0xdc00 && c <= 0xdfff).toBe(false);
      }
    }
  });
});
