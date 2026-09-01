import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drift + prose lint for the flow-confidence-rubric feature: the canonical
 * confidence + stakes rubric block at
 * `skills/pipeline/flow-product-planning/references/discovery-instructions.md`
 * is embedded verbatim (marker-delimited) in
 * `skills/pipeline/flow-pipeline/references/interview-playbook.md`. There is
 * no runtime read of the canonical file (sub-agents run in consumer
 * worktrees and can't reliably fetch a sibling skill file), so drift
 * between the two copies is a silent authoring bug this lint exists to
 * catch — same cross-file byte-identity idiom as
 * `bin/flow-value-rubric-lint.test.ts`'s "canonical block drift" describe
 * block.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

const RUBRIC_BLOCK_RE =
  /<!-- flow-confidence-rubric:begin -->\n([\s\S]*?)<!-- flow-confidence-rubric:end -->/;

/** Returns the marker-delimited block, or null when the marker is absent. Never asserts — callers assert inside their own `it` so a missing marker surfaces as a named test failure, not a suite-collection error. */
function extractRubricBlock(content: string): string | null {
  const m = content.match(RUBRIC_BLOCK_RE);
  return m ? m[1] : null;
}

const canonicalPath =
  "skills/pipeline/flow-product-planning/references/discovery-instructions.md";
const consumerPath =
  "skills/pipeline/flow-pipeline/references/interview-playbook.md";

let canonicalBlock = "";

describe("flow-confidence-rubric: canonical block drift", () => {
  it("discovery-instructions.md carries the marker-delimited block", () => {
    const block = extractRubricBlock(read(canonicalPath));
    expect(
      block,
      "discovery-instructions.md must carry a " +
        "<!-- flow-confidence-rubric:begin --> … " +
        "<!-- flow-confidence-rubric:end --> marker-delimited block.",
    ).not.toBeNull();
    canonicalBlock = block ?? "";
  });

  it("interview-playbook.md embeds the confidence rubric block byte-identical to discovery-instructions.md", () => {
    const block = extractRubricBlock(read(consumerPath));
    expect(
      block,
      "interview-playbook.md must carry a " +
        "<!-- flow-confidence-rubric:begin --> … " +
        "<!-- flow-confidence-rubric:end --> marker-delimited block.",
    ).not.toBeNull();
    expect(
      block,
      "interview-playbook.md's <!-- flow-confidence-rubric --> block must " +
        "be byte-identical to discovery-instructions.md's canonical block " +
        "— drift here means the rubric's rules disagree depending on " +
        "which skill a reader is in.",
    ).toBe(canonicalBlock);
  });
});

describe("flow-confidence-rubric: prose pins", () => {
  it("the canonical block states the label is derived from the anchor class, never asserted", () => {
    expect(
      canonicalBlock.includes("derived from the anchor class, never asserted"),
    ).toBe(true);
  });

  it("discovery-instructions.md's mechanical-floor sentence counts '[confidence: low]' items", () => {
    expect(read(canonicalPath).includes("[confidence: low]")).toBe(true);
  });

  it("pause-output-contract.md defines Crucial-and-uncertain", () => {
    expect(
      read(
        "skills/pipeline/flow-pipeline/references/pause-output-contract.md",
      ).includes("**Crucial-and-uncertain**"),
    ).toBe(true);
  });

  it("interview-playbook.md's '## 3' fenced Recommended line carries a confidence tag", () => {
    expect(read(consumerPath).includes("[confidence:")).toBe(true);
  });
});
