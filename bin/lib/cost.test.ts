import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCost, encodeProjectSegment, seedMatchesSlug } from "./cost";
import { MODEL_PRICING } from "./cost-pricing";
import type { PipelineState } from "./state";

const REPO = "/Users/test/code/me/flow";
const SLUG = "add-csv-export";
const SEED = "Use the /flow-pipeline skill for: add CSV export";

let tmpRoot: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cost-test-"));
  projectDir = path.join(tmpRoot, encodeProjectSegment(REPO));
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: object[]): void {
  fs.writeFileSync(
    path.join(projectDir, name),
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
}

function seedEvent(content = SEED): object {
  return { type: "user", message: { role: "user", content } };
}

function assistant(model: string, usage: object): object {
  return { type: "assistant", message: { model, usage } };
}

function state(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: SLUG,
    phase: "implementing",
    repo: REPO,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe(encodeProjectSegment, () => {
  it("replaces every / with - so the leading slash becomes a leading dash", () => {
    expect(encodeProjectSegment("/Users/me/code/flow")).toBe("-Users-me-code-flow");
  });

  it("handles paths without a leading slash", () => {
    expect(encodeProjectSegment("relative/path")).toBe("relative-path");
  });
});

describe(seedMatchesSlug, () => {
  it("matches the slug derived from the description after the colon", () => {
    expect(seedMatchesSlug("Use the /flow-pipeline skill for: add CSV export", "add-csv-export")).toBe(
      true,
    );
  });

  it("rejects seeds without /flow-pipeline", () => {
    expect(seedMatchesSlug("just a normal message", "add-csv-export")).toBe(false);
  });

  it("rejects when the slug doesn't match", () => {
    expect(
      seedMatchesSlug("Use the /flow-pipeline skill for: something else", "add-csv-export"),
    ).toBe(false);
  });

  it("matches a long description against its aggressive-slugify result", () => {
    // Item 15 made slugify drop English stop-words + cap at 5 tokens, so the
    // same long seed prompt now condenses to a much shorter slug. This test
    // pins seedMatchesSlug + slugify in agreement so cost lookups don't drift
    // when slugify's heuristics change again.
    const desc =
      "Proceed with pr 6 in the roadmap if the prerequisites are complete. make sure the roadmap gets updated when done";
    const slug = "proceed-pr-6-roadmap-prerequisites";
    expect(seedMatchesSlug(`Use the /flow-pipeline skill for: ${desc}`, slug)).toBe(true);
  });

  it("matches the resume-mode seed prompt format", () => {
    // `flow new --resume <slug>` seeds the supervisor with this prompt; the
    // resumed JSONL must still attribute back to the same pipeline so cost
    // counts both the pre-crash and post-resume sessions.
    expect(
      seedMatchesSlug(
        "Use the /flow-pipeline skill in --resume mode for: add-csv-export",
        "add-csv-export",
      ),
    ).toBe(true);
  });
});

describe(computeCost, () => {
  it("returns hasData:false when no JSONL matches the slug", async () => {
    writeJsonl("foreign.jsonl", [
      seedEvent("Use the /flow-pipeline skill for: a different feature"),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost).toEqual({ total: 0, byModel: {}, unknownModels: [], hasData: false });
  });

  it("returns hasData:false when the project dir does not exist", async () => {
    fs.rmSync(projectDir, { recursive: true });
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.hasData).toBe(false);
    expect(cost.total).toBe(0);
  });

  it("sums input + output across assistant events for matching JSONL", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistant("claude-sonnet-4-6", {
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.hasData).toBe(true);
    // Sonnet: $3/MTok input + $15/MTok output = $18 total.
    expect(cost.total).toBeCloseTo(18, 6);
    expect(cost.byModel["claude-sonnet-4-6"]).toBeCloseTo(18, 6);
  });

  it("prices cache-creation + cache-read tokens", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-opus-4-7", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    // Opus: $18.75 cache-create + $1.50 cache-read = $20.25
    expect(cost.total).toBeCloseTo(20.25, 6);
  });

  it("aggregates per-model totals across mixed-model sessions", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-opus-4-7", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistant("claude-sonnet-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.byModel["claude-opus-4-7"]).toBeCloseTo(15, 6);
    expect(cost.byModel["claude-sonnet-4-6"]).toBeCloseTo(3, 6);
    expect(cost.total).toBeCloseTo(18, 6);
  });

  it("records unknown models without crashing and without contributing to total", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-experimental-future", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBe(0);
    expect(cost.unknownModels).toEqual(["claude-experimental-future"]);
    expect(cost.hasData).toBe(true);
  });

  it("skips malformed JSONL lines without throwing", async () => {
    fs.writeFileSync(
      path.join(projectDir, "session.jsonl"),
      [
        JSON.stringify(seedEvent()),
        "{not valid json",
        JSON.stringify(
          assistant("claude-sonnet-4-6", {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }),
        ),
      ].join("\n"),
    );
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBeCloseTo(3, 6);
  });

  it("ignores assistant events without a usage block", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      { type: "assistant", message: { model: "claude-sonnet-4-6" } },
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBe(0);
    expect(cost.hasData).toBe(true);
  });

  it("ignores non-assistant events", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      { type: "user", message: { role: "user", content: "test" } },
      { type: "system", message: { content: "hi" } },
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBe(0);
  });

  it("treats non-numeric usage fields as zero", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", {
        input_tokens: "lots",
        output_tokens: null,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: 0,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBe(0);
  });

  it("picks the right JSONL when multiple sessions share the project dir", async () => {
    writeJsonl("a.jsonl", [
      seedEvent("Use the /flow-pipeline skill for: a different thing"),
      assistant("claude-opus-4-7", {
        input_tokens: 10_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    writeJsonl("b.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBeCloseTo(3, 6);
  });

  it("sums across all matching JSONLs when a pipeline has multiple sessions (resume)", async () => {
    // `flow new --resume` spawns a fresh Claude session and writes a second
    // JSONL whose seed-prompt also extracts back to the same slug. Cost must
    // include both pre-crash and post-resume sessions, plus aggregate
    // per-model totals and unknown-model markers across them.
    writeJsonl("pre-crash.jsonl", [
      seedEvent(),
      assistant("claude-opus-4-7", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistant("claude-experimental-future", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    writeJsonl("post-resume.jsonl", [
      seedEvent(`Use the /flow-pipeline skill in --resume mode for: ${SLUG}`),
      assistant("claude-opus-4-7", {
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistant("claude-sonnet-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    // Opus: $15 (input) + $75 (output) = $90; Sonnet: $3; total $93.
    expect(cost.total).toBeCloseTo(93, 6);
    expect(cost.byModel["claude-opus-4-7"]).toBeCloseTo(90, 6);
    expect(cost.byModel["claude-sonnet-4-6"]).toBeCloseTo(3, 6);
    expect(cost.unknownModels).toEqual(["claude-experimental-future"]);
    expect(cost.hasData).toBe(true);
  });
});

describe("MODEL_PRICING", () => {
  it("includes the three currently shipping flow-pipeline models", () => {
    expect(MODEL_PRICING["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5-20251001"]).toBeDefined();
  });

  it("attaches a friendly name to each pricing entry", () => {
    expect(MODEL_PRICING["claude-opus-4-7"]?.friendlyName).toBe("Opus 4.7");
  });
});
