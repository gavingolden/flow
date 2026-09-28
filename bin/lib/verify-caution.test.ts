import { describe, expect, it } from "vitest";
import {
  clearVerifyCaution,
  displayExcerptPath,
  upsertVerifyCaution,
} from "./verify-caution";

const BODY = "## Why\n\nbecause\n\n## Test Steps\n\n- [ ] a\n\n## Notes\n";
const OPEN = "<!-- flow:verify-caution -->";

describe("upsertVerifyCaution", () => {
  it("inserts a pointer under the heading without any excerpt content", () => {
    // The excerpt file content is never read; these strings must be absent.
    const r = upsertVerifyCaution(BODY, "/wt/.flow-tmp/verify-excerpt.txt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(false);
    expect(r.body).toContain("/wt/.flow-tmp/verify-excerpt.txt");
    expect(r.body).not.toContain("Bearer abc123");
    expect(r.body).not.toContain("GITHUB_TOKEN=ghp_");
    expect(r.body).toContain("## Test Steps\n\n<!-- flow:verify-caution -->");
    expect(r.body).toContain("> [!CAUTION]");
    expect(r.body).toContain("- [ ] a");
  });

  it("replaces on re-run, keeping exactly one open marker", () => {
    const first = upsertVerifyCaution(BODY, "/a.txt");
    if (!first.ok) throw new Error("first");
    const second = upsertVerifyCaution(first.body, "/b.txt");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replaced).toBe(true);
    expect(second.body.split(OPEN).length - 1).toBe(1);
    expect(second.body).toContain("/b.txt");
    expect(second.body).not.toContain("/a.txt");
  });

  it("fails when the Test Steps heading is missing", () => {
    expect(upsertVerifyCaution("## Why\n", "/a.txt")).toEqual({
      ok: false,
      error: "no ## Test Steps heading",
    });
  });

  it("ignores a fenced Test Steps heading", () => {
    const body = "```\n## Test Steps\n```\n";
    expect(upsertVerifyCaution(body, "/a.txt").ok).toBe(false);
  });
});

describe("caution wording and path", () => {
  it("names the next step and that the warning self-clears", () => {
    const r = upsertVerifyCaution(BODY, ".flow-tmp/verify-caution.txt");
    if (!r.ok) throw new Error("upsert");
    expect(r.body).toContain(
      "> Fix the failure, then resume the pipeline; this warning is removed automatically on the next clean verify.",
    );
    expect(r.body).toContain("`.flow-tmp/verify-caution.txt`");
  });

  it("renders a path under the toplevel relative, others unchanged", () => {
    expect(displayExcerptPath("/wt/.flow-tmp/verify-caution.txt", "/wt")).toBe(
      ".flow-tmp/verify-caution.txt",
    );
    expect(displayExcerptPath("/elsewhere/v.txt", "/wt")).toBe(
      "/elsewhere/v.txt",
    );
    expect(displayExcerptPath("/wt/v.txt")).toBe("/wt/v.txt");
  });
});

describe("caution marker robustness", () => {
  const CLOSE = "<!-- /flow:verify-caution -->";

  it("ignores markers echoed inside fenced output", () => {
    const body = `## Test Steps\n\n- [ ] a\n\n\`\`\`\n${OPEN}\n\`\`\`\n\n- [ ] b\n\n\`\`\`\n${CLOSE}\n\`\`\`\n`;
    expect(clearVerifyCaution(body)).toEqual({ body, cleared: false });
    const r = upsertVerifyCaution(body, "/a.txt");
    if (!r.ok) throw new Error("upsert");
    expect(r.replaced).toBe(false);
    expect(r.body).toContain("- [ ] a");
    expect(r.body).toContain("- [ ] b");
  });

  it("an open marker without a close does not stack a second block", () => {
    const body = `## Test Steps\n\n${OPEN}\n> [!CAUTION]\n> old\n\n- [ ] a\n`;
    const r = upsertVerifyCaution(body, "/a.txt");
    if (!r.ok) throw new Error("upsert");
    expect(r.body.split(OPEN).length - 1).toBe(1);
    expect(r.body).not.toContain("> old");
    expect(r.body).toContain("- [ ] a");
  });
});

describe("clearVerifyCaution", () => {
  it("removes the block leaving the rest byte-identical", () => {
    const ins = upsertVerifyCaution(BODY, "/a.txt");
    if (!ins.ok) throw new Error("ins");
    expect(clearVerifyCaution(ins.body)).toEqual({
      body: BODY,
      cleared: true,
    });
  });

  it("round-trips byte-identically when no blank line follows the heading", () => {
    const tight = "## Test Steps\n- [ ] a\n";
    const ins = upsertVerifyCaution(tight, "/a.txt");
    if (!ins.ok) throw new Error("ins");
    expect(clearVerifyCaution(ins.body).body).toBe(tight);
  });

  it("reports cleared:false when there is no block", () => {
    expect(clearVerifyCaution(BODY)).toEqual({ body: BODY, cleared: false });
  });
});
