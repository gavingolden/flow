import { describe, expect, it } from "vitest";

import {
  buildCritiquePrompt,
  extractLayoutIntent,
  parseJsonReply,
  type CritiquePromptInput,
} from "./ui-critique-prompt";

describe("extractLayoutIntent", () => {
  const plan = [
    "# Plan",
    "",
    "## Layout Intent",
    "",
    "- **Design intent:** calm",
    "```",
    "## not a heading",
    "```",
    "- **Polish bar:** one focal point",
    "",
    "## Task breakdown",
    "",
    "x",
  ].join("\n");

  it("returns the section body, fence-aware, up to the next ## heading", () => {
    const body = extractLayoutIntent(plan);
    expect(body).toContain("**Design intent:** calm");
    expect(body).toContain("## not a heading");
    expect(body).toContain("**Polish bar:**");
    expect(body).not.toContain("Task breakdown");
  });

  it("runs to end-of-file when no heading follows", () => {
    expect(extractLayoutIntent("## Layout Intent\n\nregions: a, b\n")).toBe(
      "regions: a, b",
    );
  });

  it("is null when the section is absent or empty", () => {
    expect(extractLayoutIntent("# Plan\n\n## Other\n")).toBeNull();
    expect(extractLayoutIntent("## Layout Intent\n\n## Next\n")).toBeNull();
  });

  it("caps the body at 6000 chars", () => {
    const body = extractLayoutIntent(`## Layout Intent\n\n${"x".repeat(9000)}`);
    expect(body).toHaveLength(6000);
  });
});

describe("buildCritiquePrompt", () => {
  const input: CritiquePromptInput = {
    shots: [
      {
        route: "/",
        section: "Pricing",
        viewport: "phone",
        part: "whole",
        path: "/wt/.flow-tmp/ui-evidence/pricing-phone.png",
      },
    ],
    snapshots: [
      { route: "/", path: "/wt/.flow-tmp/ui-evidence/snap-home.txt" },
    ],
    layoutIntent: "Design intent: calm",
    ruleDocPaths: [
      "/wt/.flow-tmp/ui-critique/rules/layout.md",
      "/wt/.flow-tmp/ui-critique/rules/rendered-critique.md",
    ],
    smells: ["[phone] wall: main"],
    phase: "round-0",
  };

  it("lists every path on its own line, rubric first", () => {
    const p = buildCritiquePrompt(input);
    const lines = p.split("\n");
    for (const path of [
      ...input.ruleDocPaths,
      input.snapshots[0].path,
      input.shots[0].path,
    ]) {
      expect(lines.some((l) => l.startsWith(path))).toBe(true);
    }
    expect(p.indexOf("rendered-critique.md")).toBeLessThan(
      p.indexOf("layout.md"),
    );
    expect(p).toContain("Design intent: calm");
    expect(p).toContain("- [phone] wall: main");
    expect(p).toContain('{"findings":');
  });

  it("states that no design intent was ratified when there is none", () => {
    const p = buildCritiquePrompt({ ...input, layoutIntent: null });
    expect(p).toContain("No design intent was ratified");
    expect(p).not.toContain("Design intent: calm");
  });

  it("omits the smells block when there are none", () => {
    expect(buildCritiquePrompt({ ...input, smells: [] })).not.toContain(
      "Page-check smells",
    );
  });

  it("the post-round prompt is blind: fresh framing and no earlier findings", () => {
    const p = buildCritiquePrompt({ ...input, phase: "post-round" });
    expect(p).toContain("as if you had never seen it before");
    expect(p).not.toMatch(/previous|earlier finding|what changed|fixed/i);
  });
});

describe("parseJsonReply", () => {
  it("returns the first balanced object, ignoring surrounding prose", () => {
    expect(parseJsonReply('Here: {"findings":[]} thanks')).toEqual({
      findings: [],
    });
  });

  it("handles braces and escaped quotes inside strings", () => {
    expect(
      parseJsonReply('{"a":"x } \\" {","b":{"c":1}} tail {"z":1}'),
    ).toEqual({
      a: 'x } " {',
      b: { c: 1 },
    });
  });

  it("skips an unparsable balanced block and tries the next one", () => {
    expect(parseJsonReply('{not json} {"ok":true}')).toEqual({ ok: true });
  });

  it("is null when nothing parses", () => {
    expect(parseJsonReply("no json here")).toBeNull();
    expect(parseJsonReply('{"open":')).toBeNull();
    expect(parseJsonReply("")).toBeNull();
  });
});
