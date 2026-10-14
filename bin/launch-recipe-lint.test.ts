import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Issue #930: Claude Code's removal-safety check refuses an `eval` of a
 * runtime-computed string in a sub-agent, and the hand-quoted inline
 * `sh -c '<launch>'` recipe is the improvisation that produced the same
 * refused shape. The app launch goes through `flow-spawn --from-envelope`
 * only, so no skill/template/reference/agent may instruct either old form,
 * and the two recipe sites must name the new flag.
 *
 * `fs.readFileSync`-based (never the shell `grep`, which treats
 * `ui-smoke-pass.md`'s very long lines as binary and skips them).
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const WALKED_DIRS = ["skills", "templates", "references", "agents"];

const RECIPE_SITES = [
  "skills/pipeline/flow-pipeline/references/ui-smoke-pass.md",
  "skills/pipeline/flow-ui-driver-instructions/SKILL.md",
];

type Rule = { name: string; test: (line: string) => boolean };

// An INSTRUCTED eval (`eval "$…"` / `eval $…`) on a launch line — a negated
// prose mention such as "no `eval`" does not fire.
const RULES: Rule[] = [
  {
    name: "FLOW_UI_LAUNCH env fallback",
    test: (l) => /FLOW_UI_LAUNCH/.test(l),
  },
  {
    name: "eval of a launch string",
    test: (l) => /\beval\s+["']?\$/.test(l) && /launch|flow-spawn/i.test(l),
  },
  {
    name: "inline sh -c '<launch>' recipe",
    test: (l) => /sh -c '<(meta\.)?launch>'/.test(l),
  },
];

function violations(text: string): { rule: string; line: number }[] {
  const out: { rule: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    for (const r of RULES)
      if (r.test(l)) out.push({ rule: r.name, line: i + 1 });
  });
  return out;
}

function markdownFiles(relDir: string): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

const DOCS = WALKED_DIRS.flatMap(markdownFiles);

describe("launch-recipe lint", () => {
  it("walks a non-trivial doc set", () => {
    expect(DOCS.length).toBeGreaterThan(20);
  });

  it("no doc instructs an eval of a launch string or the inline sh -c recipe", () => {
    const found = DOCS.flatMap((rel) =>
      violations(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")).map(
        (v) => `${rel}:${v.line} (${v.rule})`,
      ),
    );
    expect(found, found.join("\n")).toEqual([]);
  });

  it.each(RECIPE_SITES)("%s pins --from-envelope", (rel) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    expect(text, `${rel} missing --from-envelope`).toContain("--from-envelope");
  });
});

describe("launch-recipe lint — self-tests", () => {
  it.each([
    [
      "the old eval recipe",
      `FLOW_UI_LAUNCH='x' flow-spawn --class default -- sh -c 'eval "$FLOW_UI_LAUNCH"'`,
    ],
    [
      "the old inline recipe",
      "flow-spawn --class default -- sh -c '<meta.launch>'",
    ],
  ])("fires on %s", (_label, line) => {
    expect(violations(line).length).toBeGreaterThan(0);
  });

  it.each([
    [
      "the PR-review validator eval",
      'eval "$VALIDATE_CMD \\"\\$ARTIFACT_PATH\\""',
    ],
    ["the word 'evals'", "paid evals of the launch recipe"],
    [
      "a negated prose mention",
      "launch it via flow-spawn — no `eval`, no env prefix",
    ],
  ])("does not fire on %s", (_label, line) => {
    expect(violations(line)).toEqual([]);
  });
});
