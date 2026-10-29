import { describe, expect, it } from "vitest";
import { findArrowDeltaBullets } from "./pr-delta-bullets";

const body = (userFacing: string, system = "none") =>
  `## TLDR\n\nx\n\n## User-facing changes\n\n${userFacing}\n\n## System changes\n\n${system}\n\n## Why\n\nbecause a → b\n`;

describe("findArrowDeltaBullets", () => {
  // Flagged shapes
  it("should warn when a change bullet starts with a Before → After prefix", () => {
    const out = findArrowDeltaBullets(
      body(
        "- Before → After: `flow add` (removed) is now `flow feature create`.",
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(
      /^warn: PR '## User-facing changes' has 1 change bullet\(s\)/,
    );
  });

  it("should warn when a change bullet carries **Before:** and **After:** on one line", () => {
    const out = findArrowDeltaBullets(
      body("- Output changed: **Before:** one line. **After:** two lines."),
    );
    expect(out).toHaveLength(1);
  });

  it("should warn on a CRLF body", () => {
    expect(
      findArrowDeltaBullets(body("- a → b").replace(/\n/g, "\r\n")),
    ).toHaveLength(1);
  });

  it("should warn when a top-level **Before:** bullet has no outcome parent bullet", () => {
    const out = findArrowDeltaBullets(
      body(
        "- **Before:** you ran `flow add`.\n- **After:** you run `flow feature create`.",
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("has 2 change bullet(s)");
  });

  it("should warn when a change bullet joins two clauses with a bare → or -> arrow", () => {
    expect(
      findArrowDeltaBullets(body("- Default model: sonnet → opus.")),
    ).toHaveLength(1);
    expect(
      findArrowDeltaBullets(body("- Default model: sonnet -> opus.")),
    ).toHaveLength(1);
  });

  it("should warn once per section, counting every flagged bullet in it", () => {
    const out = findArrowDeltaBullets(
      body("- a → b\n- c -> d\n- plain new capability"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("has 2 change bullet(s)");
  });

  it("should check ## System changes the same way as ## User-facing changes", () => {
    const out = findArrowDeltaBullets(body("none", "- Cache: off → on."));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^warn: PR '## System changes' has 1 /);
    const both = findArrowDeltaBullets(body("- a → b", "- c → d"));
    expect(both).toHaveLength(2);
  });

  // Clean shapes
  it("should not warn when a changed behavior uses an outcome parent with nested **Before:** / **After:** sub-bullets", () => {
    const pair =
      "- Starting a pipeline now takes the feature subcommand:\n  - **Before:** you ran `flow add`.\n  - **After:** you run `flow feature create`.";
    expect(findArrowDeltaBullets(body(pair, pair))).toEqual([]);
  });

  it("should not warn when a nested pair or its parent carries a prose arrow", () => {
    const pair =
      "- Model routing is explicit:\n  - **Before:** the model was implicit.\n  - **After:** the pick goes sonnet → opus per phase.";
    expect(findArrowDeltaBullets(body(pair))).toEqual([]);
    const arrowInParent =
      "- Routing runs plan → build:\n  - **Before:** one phase.\n  - **After:** two phases.";
    expect(findArrowDeltaBullets(body(arrowInParent))).toEqual([]);
  });

  it("should not warn when a nested **After:** sub-bullet mentions both bold labels", () => {
    const pair =
      "- PR change bullets now show each side on its own line:\n  - **Before:** one long arrow line.\n  - **After:** a headline with lines labeled **Before:** and **After:**.";
    expect(findArrowDeltaBullets(body(pair))).toEqual([]);
  });

  it("should not warn when a brand-new capability is a single plain bullet", () => {
    expect(
      findArrowDeltaBullets(
        body("- New flag: `flow ls --cost` adds a `$` column."),
      ),
    ).toEqual([]);
  });

  it("should not warn when the only arrow sits inside inline code", () => {
    expect(
      findArrowDeltaBullets(
        body("- Run `flow a -> b` or `Before → After` to see it."),
      ),
    ).toEqual([]);
  });

  it("should not warn when the only arrow sits inside a fenced block or HTML comment", () => {
    const fenced =
      "- Output now looks like:\n\n```\n- a → b\n- Before → After: x\n```";
    expect(findArrowDeltaBullets(body(fenced))).toEqual([]);
    const comment = "<!-- - Before → After: x → y -->\n- plain";
    expect(findArrowDeltaBullets(body(comment))).toEqual([]);
  });

  it("should not warn when the body has no change sections", () => {
    expect(findArrowDeltaBullets("## TLDR\n\n- a → b\n")).toEqual([]);
    expect(findArrowDeltaBullets("")).toEqual([]);
  });

  it("should not warn on arrows in sections other than the two change sections", () => {
    const text =
      "## Why\n\n- a → b\n\n## Key decisions\n\n- Before → After: x\n\n## User-facing changes\n\n- plain\n";
    expect(findArrowDeltaBullets(text)).toEqual([]);
  });
});
