import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT } from "./flow-research-run";

/**
 * Structural lint for the F2 research pre-check budget wiring in
 * `skills/pipeline/flow-product-planning/references/discovery-research.md`.
 *
 * Step 1.5 of that file reads two OPTIONAL `~/.flow/config.json` budget keys
 * (`research.maxCalls` / `research.timeout`) and threads them into the
 * `flow-delegate-fanout` invocation, defaulting to byte-exact v1 values when a
 * key is absent or malformed. The models come from one call to
 * `flow-research-run --print-models`, made only after the research-module
 * precheck; the doc names no model. The tolerant-fallback contract (absent OR
 * present-but-wrong-type -> default, never throws) is load-bearing because the
 * research pass must never block planning. This lint freezes all of that: a
 * future edit that drops a default, drops the helper call, reorders the
 * precheck after it, names a model, or breaks the warn-and-default prose goes
 * red on `npm run verify`.
 *
 * Anchors here are deliberately disjoint from `bin/skill-md-lint.test.ts`'s
 * existing Step-1.5 Prompt-interpretation/enum assertions (it asserts on the
 * routing enum region, this asserts on the budget keys + model pins), so the
 * two lints do not duplicate or collide.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERY_RESEARCH_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "pipeline",
  "flow-product-planning",
  "references",
  "discovery-research.md",
);
const content = fs.readFileSync(DISCOVERY_RESEARCH_PATH, "utf8");

const FILE_LABEL =
  "skills/pipeline/flow-product-planning/references/discovery-research.md";

const MODEL_NAME_RE =
  /(Claude (Opus|Sonnet|Haiku|Fable) [0-9.]+|GPT-OSS [0-9]+B|Gemini [0-9.]+ [A-Za-z]+) \((Low|Medium|High|Thinking)\)/;

describe("F2 research budget config lint", () => {
  it("wires both optional budget keys into Step 1.5", () => {
    const keys = ["research.maxCalls", "research.timeout"];
    const missing = keys.filter((k) => !content.includes(k));
    expect(
      missing,
      `${FILE_LABEL} Step 1.5 must read both optional budget keys. ` +
        `Missing: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("resolves models through flow-research-run --print-models, after the module precheck", () => {
    const call = content.indexOf("flow-research-run --print-models");
    const precheck = content.indexOf("flow-module-status --check research");
    expect(
      call,
      `${FILE_LABEL} must call flow-research-run --print-models`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      precheck,
      `${FILE_LABEL} lost the module precheck`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      precheck,
      "the module precheck must come before model resolution",
    ).toBeLessThan(call);
    expect(content).toContain("research-model-lookup-failed");
  });

  it("names no model", () => {
    const hit = content.split("\n").find((l) => MODEL_NAME_RE.test(l));
    expect(hit, `${FILE_LABEL} names a model: ${hit}`).toBeUndefined();
  });

  it("keeps the byte-exact v1 budget defaults", () => {
    // maxCalls default 12 (as the type-guarded read default), timeout default
    // the exported research limit (DEFAULT_TIMEOUT).
    expect(
      content.includes("read_budget maxCalls number 12"),
      `${FILE_LABEL} must default research.maxCalls to 12 in the tolerant read.`,
    ).toBe(true);
    expect(
      content.includes(`read_budget timeout string "${DEFAULT_TIMEOUT}"`),
      `${FILE_LABEL} must default research.timeout to "${DEFAULT_TIMEOUT}" in the tolerant read.`,
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
      /cross-model diversity guard/i.test(content),
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
