import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSkillSet, stripModelAndEffort } from "./eval-config";

let scratch!: string;
let flowSource!: string;
let mirror!: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-config-"));
  flowSource = path.join(scratch, "flow");
  mirror = path.join(scratch, "mirror");
  // Build a fake flow source with one skill.
  const skillDir = path.join(flowSource, "skills", "pipeline", "new-feature");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: new-feature\nmodel: claude-sonnet-4-6\neffort: high\ndescription: foo\n---\n\nbody\n",
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("stripModelAndEffort", () => {
  it("removes model: and effort: lines", () => {
    const out = stripModelAndEffort(
      "---\nname: x\nmodel: claude-opus-4-7\neffort: xhigh\ndescription: y\n---\nbody\n",
    );
    expect(out).not.toContain("model:");
    expect(out).not.toContain("effort:");
    expect(out).toContain("name: x");
    expect(out).toContain("description: y");
    expect(out).toContain("body");
  });

  it("is a no-op when those keys are absent", () => {
    const input = "---\nname: x\ndescription: y\n---\nbody\n";
    expect(stripModelAndEffort(input)).toBe(input);
  });

  it("returns the input unchanged when there is no frontmatter", () => {
    const input = "no frontmatter here\nmodel: stays\n";
    expect(stripModelAndEffort(input)).toBe(input);
  });
});

describe("buildSkillSet", () => {
  it("returns the live path for pr7 without copying", () => {
    const out = buildSkillSet("pr7", flowSource, mirror);
    expect(out).toBe(path.join(flowSource, "skills", "pipeline"));
    expect(fs.existsSync(mirror)).toBe(false);
  });

  it("creates a stripped mirror for defaults", () => {
    const out = buildSkillSet("defaults", flowSource, mirror);
    expect(out).toBe(mirror);
    const md = fs.readFileSync(path.join(mirror, "new-feature", "SKILL.md"), "utf8");
    expect(md).not.toContain("model:");
    expect(md).not.toContain("effort:");
    expect(md).toContain("name: new-feature");
  });

  it("throws when the flow source skills directory is missing", () => {
    expect(() => buildSkillSet("pr7", path.join(scratch, "no-flow"), mirror)).toThrow(
      /skills missing/,
    );
  });

  it("skips skill names that don't exist in the source tree", () => {
    // Only `new-feature` exists in the fake source; `flow-pipeline` etc. should be skipped.
    expect(() => buildSkillSet("defaults", flowSource, mirror)).not.toThrow();
    expect(fs.existsSync(path.join(mirror, "flow-pipeline"))).toBe(false);
  });
});
