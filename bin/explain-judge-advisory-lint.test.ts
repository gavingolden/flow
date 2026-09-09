import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint pinning the explanation judge's advisory ceiling: the
 * verdict can never reach a gate decision or a terminal render, so a
 * `rewrite` verdict can never strand a pipeline non-terminal.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const GATE_DECIDE_PATH = path.join(REPO_ROOT, "bin/flow-gate-decide.ts");
const GATE_SUMMARY_PATH = path.join(REPO_ROOT, "bin/flow-gate-summary.ts");
const SKILL_MD_PATH = path.join(
  REPO_ROOT,
  "skills/pipeline/flow-pipeline/SKILL.md",
);
const EXPLAIN_JUDGE_TEST_PATH = path.join(
  REPO_ROOT,
  "bin/flow-explain-judge.test.ts",
);

function readStep5(content: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^## Step 5\b/.test(l.trim()));
  expect(
    startIdx,
    "skills/pipeline/flow-pipeline/SKILL.md must have a '## Step 5' heading.",
  ).toBeGreaterThan(-1);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

describe("explain-judge advisory ceiling lint", () => {
  it("flow-gate-decide.ts never mentions explain-judge", () => {
    const content = fs.readFileSync(GATE_DECIDE_PATH, "utf8");
    expect(content.includes("explain-judge")).toBe(false);
  });

  it("flow-gate-summary.ts never mentions explain-judge", () => {
    const content = fs.readFileSync(GATE_SUMMARY_PATH, "utf8");
    expect(content.includes("explain-judge")).toBe(false);
  });

  it("Step 5's SKILL.md section wires the judge with the documented rewrite/re-judge/proceed contract", () => {
    const content = fs.readFileSync(SKILL_MD_PATH, "utf8");
    const step5 = readStep5(content);
    for (const token of [
      "flow-explain-judge",
      '--sections "## Why,## User-facing changes"',
      "re-judge once",
      "proceed regardless",
      "product.judge",
      ".pr // empty",
    ]) {
      expect(
        step5.includes(token),
        `SKILL.md's Step 5 section must contain '${token}'.`,
      ).toBe(true);
    }
  });

  it("bin/flow-explain-judge.test.ts never imports node:child_process", () => {
    const content = fs.readFileSync(EXPLAIN_JUDGE_TEST_PATH, "utf8");
    expect(content.includes("node:child_process")).toBe(false);
  });
});
