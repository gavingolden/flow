import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint for the F2 research pre-check budget wiring in
 * `skills/pipeline/product-planning/references/discovery-instructions.md`.
 *
 * Step 1.5 of that file reads four OPTIONAL `~/.flow/config.json` budget keys
 * (`research.maxCalls` / `research.timeout` / `research.model` /
 * `research.refuteModel`) and threads them into the `flow-delegate-fanout`
 * invocation, defaulting to byte-exact v1 values when a key is absent or
 * malformed. The model strings are live `agy` model-variant pins — a paraphrase
 * silently breaks the fan-out — and the tolerant-fallback contract (absent OR
 * present-but-wrong-type -> default, never throws) is load-bearing because the
 * research pass must never block planning. This lint freezes all of that: a
 * future edit that drops a default, paraphrases a model pin, removes the
 * cross-model diversity guard, or breaks the warn-and-default prose goes red on
 * `npm run verify` instead of silently shipping a broken read.
 *
 * Anchors here are deliberately disjoint from `bin/skill-md-lint.test.ts`'s
 * existing Step-1.5 Prompt-interpretation/enum assertions (it asserts on the
 * routing enum region, this asserts on the budget keys + model pins), so the
 * two lints do not duplicate or collide.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERY_INSTRUCTIONS_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "product-planning",
  "references",
  "discovery-instructions.md",
);
const content = fs.readFileSync(DISCOVERY_INSTRUCTIONS_PATH, "utf8");

const FILE_LABEL =
  "skills/pipeline/product-planning/references/discovery-instructions.md";

// The forced (`flow feature create --research`) path runs bin/flow-research-run.ts, which
// keeps its OWN copy of the model-variant pins + cross-model diversity-guard
// fallback ordering. That copy must stay byte-identical to the doc's frozen
// block — otherwise the forced path and the config-on path research with
// different models, silently. This cross-file read binds the two so a rename of
// either copy goes red on `npm run verify`.
const RESEARCH_RUN_PATH = path.resolve(HERE, "flow-research-run.ts");
const researchRunContent = fs.readFileSync(RESEARCH_RUN_PATH, "utf8");

describe("F2 research budget config lint", () => {
  it("wires all four optional budget keys into Step 1.5", () => {
    const keys = [
      "research.maxCalls",
      "research.timeout",
      "research.model",
      "research.refuteModel",
    ];
    const missing = keys.filter((k) => !content.includes(k));
    expect(
      missing,
      `${FILE_LABEL} Step 1.5 must read all four optional budget keys ` +
        `(research.maxCalls / research.timeout / research.model / ` +
        `research.refuteModel). Missing: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("preserves the byte-exact agy model-variant pins", () => {
    const pins = [
      "Gemini 3.1 Pro (High)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ];
    const missing = pins.filter((p) => !content.includes(p));
    expect(
      missing,
      `${FILE_LABEL} must reproduce the agy model-variant pins byte-for-byte ` +
        `(they are live model ids — a paraphrase silently breaks the fan-out). ` +
        `Missing: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("keeps the byte-exact v1 budget defaults", () => {
    // maxCalls default 12 (as the type-guarded read default), timeout default 3m.
    expect(
      content.includes("read_budget maxCalls number 12"),
      `${FILE_LABEL} must default research.maxCalls to 12 in the tolerant read.`,
    ).toBe(true);
    expect(
      content.includes('read_budget timeout string "3m"'),
      `${FILE_LABEL} must default research.timeout to "3m" in the tolerant read.`,
    ).toBe(true);
    expect(
      content.includes('read_budget model string "Gemini 3.1 Pro (High)"'),
      `${FILE_LABEL} must default research.model (gather) to ` +
        `"Gemini 3.1 Pro (High)".`,
    ).toBe(true);
    expect(
      content.includes(
        'read_budget refuteModel string "Claude Opus 4.6 (Thinking)"',
      ),
      `${FILE_LABEL} must default research.refuteModel to ` +
        `"Claude Opus 4.6 (Thinking)".`,
    ).toBe(true);
  });

  it("documents the warn-and-default (never-throws) tolerant contract", () => {
    expect(
      content.includes("is present but not a"),
      `${FILE_LABEL} must emit a loud stderr warning naming a present-but-` +
        `wrong-type key (the "is present but not a <type>" warn message).`,
    ).toBe(true);
    expect(
      content.includes("never throws"),
      `${FILE_LABEL} must state the tolerant read never throws (a malformed ` +
        `key degrades to the default, it does not abort the research pass).`,
    ).toBe(true);
  });

  it("keeps the cross-model diversity guard for the refute entry", () => {
    expect(
      content.includes("Cross-model diversity guard"),
      `${FILE_LABEL} must keep the cross-model diversity guard so the REFUTE ` +
        `entry always runs on a different variant from GATHER.`,
    ).toBe(true);
  });

  it("pins --concurrency 4 as not operator-tunable", () => {
    expect(
      content.includes("--concurrency 4"),
      `${FILE_LABEL} must keep --concurrency 4 literal — it is load-bearing ` +
        `in the runtime-ceiling arithmetic and is out of scope to tune.`,
    ).toBe(true);
  });

  it("binds bin/flow-research-run.ts's model pins to the doc's frozen pins (no silent drift)", () => {
    // Same three pins the doc freezes, including the GPT-OSS fallback the
    // diversity guard swaps to on an Opus collision — their co-presence in the
    // helper catches a rename of either copy that the doc-only freeze would miss.
    const pins = [
      "Gemini 3.1 Pro (High)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ];
    const missing = pins.filter((p) => !researchRunContent.includes(p));
    expect(
      missing,
      `bin/flow-research-run.ts (the forced --research path) must reproduce the ` +
        `same agy model-variant pins as ${FILE_LABEL} byte-for-byte — the forced ` +
        `path runs this helper while the config-on path runs the doc's bash, so a ` +
        `divergence silently researches with different models. Missing: ` +
        `${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("self-references this lint so the doc's freeze claim stays anchored", () => {
    expect(
      content.includes("flow-research-budget-lint.test.ts"),
      `${FILE_LABEL} must name 'flow-research-budget-lint.test.ts' so its claim ` +
        `that the budget defaults + model pins are lint-frozen points at the ` +
        `real lint (this file). If you rename this test, update the doc ` +
        `reference in the same commit.`,
    ).toBe(true);
  });
});
