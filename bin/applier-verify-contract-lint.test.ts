import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STACK_TABLE } from "./lib/stack-table";

/**
 * Pins the verify-call contract of the edit-applier, the fix-applier and
 * /flow-verify (which the fix-applier runs inline): the verify call carries
 * an explicit 10-minute Bash timeout, no skill claims `flow-pre-commit`
 * formats (it never does: `format` is on the stack table's denylist), and
 * the applier's verify stays the whole-diff `flow-pre-commit --json`. The
 * last one guards against the narrowed-verify idea (#892) coming back.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (rel: string) =>
  fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CODER = "skills/pipeline/flow-coder-instructions/SKILL.md";
const FIX = "skills/pipeline/flow-fix-applier-instructions/SKILL.md";
const VERIFY = "skills/pipeline/flow-verify/SKILL.md";

function skillFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
    .flatMap((e) => {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) return skillFiles(rel);
      return e.name === "SKILL.md" ? [rel] : [];
    });
}

describe("applier verify contract", () => {
  it("should require timeout: 600000 near each flow-pre-commit code block", () => {
    for (const rel of [CODER, FIX, VERIFY]) {
      const lines = read(rel).split("\n");
      const fence = lines.findIndex(
        (l, i) =>
          l.startsWith("```") && lines[i + 1]?.includes("flow-pre-commit"),
      );
      expect(fence, `${rel}: no flow-pre-commit code block`).toBeGreaterThan(
        -1,
      );
      const window = lines.slice(fence, fence + 15).join("\n");
      expect(window, rel).toContain("timeout: 600000");
    }
  });

  it("should not claim the verify helper formats", () => {
    const claims = [
      /flow-pre-commit[^\n]*runs (`npm run format`|format \+ checks)/,
      /runs `npm run format` first/,
    ];
    for (const rel of skillFiles("skills")) {
      const flat = read(rel).replace(/\s*\n\s*/g, " ");
      for (const re of claims)
        expect(flat, `${rel} matches ${re}`).not.toMatch(re);
    }
    expect(read(FIX).replace(/\s*\n\s*/g, " ")).not.toMatch(
      /full check suite \([^)]*\bformat\b/,
    );
    expect(STACK_TABLE["package.json"].denylist).toContain("format");
  });

  it("should keep the applier verify a whole-diff run that is never skipped", () => {
    const text = read(CODER);
    expect(text).toContain("NEVER skip the `flow-pre-commit --json` re-run");
    const step3 = text.slice(
      text.indexOf("## 3. Run pre-commit verification"),
      text.indexOf("## 4."),
    );
    const blocks = [...step3.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(
      (m) => m[1],
    );
    expect(blocks).toEqual(["flow-pre-commit --json"]);
  });
});
