import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIEF_MAX_BYTES,
  LENS_HEADINGS,
  extractLensBlock,
  extractSharedBlock,
  isLensPackEnabled,
  renderAllBriefs,
  renderLensBrief,
  runLensPackStep,
  type PackInputs,
} from "./review-pack";

const FIX = path.join(import.meta.dir ?? __dirname, "../fixtures/review-pack");
const LIVE_PROMPTS = path.join(
  __dirname,
  "../../skills/pipeline/flow-pr-review/references/agent-prompts.md",
);

let wt: string;
const fsRead = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const exec = () => ({ stdout: "", stderr: "", exitCode: 1 });

beforeEach(() => {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "review-pack-"));
  fs.cpSync(path.join(FIX, "inputs"), path.join(wt, ".flow-tmp"), {
    recursive: true,
  });
});
afterEach(() => fs.rmSync(wt, { recursive: true, force: true }));

function inputs(over: Partial<PackInputs> = {}): PackInputs {
  return {
    lens: "bug-detection",
    skillDir: path.join(FIX, "skill"),
    worktree: wt,
    base: "main",
    promptInterpretationTension: false,
    read: fsRead,
    exec,
    ...over,
  };
}

describe("LENS_HEADINGS", () => {
  it("pins all seven headings against the live agent-prompts.md", () => {
    const md = fs.readFileSync(LIVE_PROMPTS, "utf8");
    expect(Object.keys(LENS_HEADINGS)).toHaveLength(7);
    for (const lens of Object.keys(
      LENS_HEADINGS,
    ) as (keyof typeof LENS_HEADINGS)[]) {
      expect(extractLensBlock(md, lens).startsWith(LENS_HEADINGS[lens])).toBe(
        true,
      );
    }
    expect(extractSharedBlock(md)).toContain("{{DIFF}}");
  });

  it("renders a brief for every lens from the live template", () => {
    for (const lens of Object.keys(
      LENS_HEADINGS,
    ) as (keyof typeof LENS_HEADINGS)[]) {
      const r = renderLensBrief(
        inputs({
          lens,
          skillDir: path.join(
            __dirname,
            "../../skills/pipeline/flow-pr-review",
          ),
        }),
      );
      expect("text" in r).toBe(true);
      if ("text" in r) expect(r.text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });
});

describe("renderLensBrief", () => {
  it("substitutes every variable and puts the shared block first, lens suffix last", () => {
    const r = renderLensBrief(
      inputs({ lens: "product", productBriefPath: "/b.md" }),
    );
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(r.text.startsWith("You are a specialized code reviewer.")).toBe(
      true,
    );
    expect(r.text).toContain("PR #7: Add widget");
    expect(r.text).toContain("Adds a widget.");
    expect(r.text).toContain("`/b.md`");
    expect(r.text.indexOf("## Inputs supplied in this brief")).toBeLessThan(
      r.text.indexOf("## Product Agent"),
    );
    expect(r.text.trimEnd().endsWith("block is above.")).toBe(true);
    expect(r.text.match(/"meta"/g)).toHaveLength(1);
  });

  it("appends the base-branch review checklist when present", () => {
    const r = renderLensBrief(
      inputs({
        exec: () => ({ stdout: "- project rule\n", stderr: "", exitCode: 0 }),
      }),
    );
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text).toContain("project rule");
  });

  it("returns an error naming a missing heading", () => {
    const skill = path.join(wt, "skill");
    fs.cpSync(path.join(FIX, "skill"), skill, { recursive: true });
    const p = path.join(skill, "references", "agent-prompts.md");
    fs.writeFileSync(
      p,
      fs.readFileSync(p, "utf8").replace("## Security Agent", "## Sec"),
    );
    const r = renderLensBrief(inputs({ lens: "security", skillDir: skill }));
    expect(r).toEqual({
      error: "agent-prompts.md: '## Security Agent' heading not found",
    });
  });

  it("truncates commit bodies and intent comments first, then errors", () => {
    const big = "x".repeat(BRIEF_MAX_BYTES);
    fs.writeFileSync(
      path.join(wt, ".flow-tmp", "pr-commits.md"),
      `abc1234 feat: head\n${big}\n---\n`,
    );
    const ok = renderLensBrief(inputs());
    if (!("text" in ok)) throw new Error(ok.error);
    expect(ok.text).toContain("abc1234 feat: head");
    expect(ok.text).not.toContain("xxxx");

    fs.writeFileSync(path.join(wt, ".flow-tmp", "diff.txt"), big);
    const bad = renderLensBrief(inputs());
    expect("error" in bad && bad.error).toContain("over the 80000-byte cap");
  });

  it("does not rescan substituted values for template variables", () => {
    fs.writeFileSync(
      path.join(wt, ".flow-tmp", "diff.txt"),
      "+ {{PR_TITLE}} literal\n",
    );
    const r = renderLensBrief(inputs());
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text).toContain("+ {{PR_TITLE}} literal");
  });
});

describe("renderAllBriefs", () => {
  it("writes one file per run:true lens and skips gated lenses", () => {
    const scope = JSON.parse(
      fs.readFileSync(path.join(wt, ".flow-tmp", "review-scope.json"), "utf8"),
    );
    const { lens_prompts, skipped } = renderAllBriefs({ ...inputs(), scope });
    expect(Object.keys(lens_prompts).sort()).toEqual(
      Object.keys(LENS_HEADINGS)
        .filter((l) => l !== "supply-chain")
        .sort(),
    );
    expect(skipped).toEqual([]);
    expect(fs.existsSync(lens_prompts["bug-detection"]!)).toBe(true);
    expect(fs.readFileSync(lens_prompts.product!, "utf8")).toContain(
      "/repo/.flow/product.md",
    );
  });
});

describe("isLensPackEnabled", () => {
  it("is true only for a strict boolean true", () => {
    expect(isLensPackEnabled(() => ({ review: { lensPack: true } }))).toBe(
      true,
    );
    for (const v of ["true", 1, null, undefined, false]) {
      expect(isLensPackEnabled(() => ({ review: { lensPack: v } }))).toBe(
        false,
      );
    }
    expect(isLensPackEnabled(() => ({}))).toBe(false);
    expect(isLensPackEnabled(() => null)).toBe(false);
    expect(
      isLensPackEnabled(() => {
        throw new Error("x");
      }),
    ).toBe(false);
  });
});

describe("runLensPackStep stale-brief clearing", () => {
  it("removes every lens-prompt-<lens>.md left by an earlier round when the pack is off", () => {
    const stale = Object.keys(LENS_HEADINGS).map((l) =>
      path.join(wt, ".flow-tmp", `lens-prompt-${l}.md`),
    );
    for (const f of stale) fs.writeFileSync(f, "stale");
    const step = runLensPackStep({
      pr: 1,
      worktree: wt,
      skillDir: path.join(FIX, "skill"),
      readConfig: () => ({}),
      promptInterpretationTension: false,
      read: fsRead,
      exec,
    });
    expect(step.lens_prompts).toEqual({});
    for (const f of stale) expect(fs.existsSync(f)).toBe(false);
  });
});
