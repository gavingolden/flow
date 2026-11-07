import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRICES } from "../../docs/eval/token-spend-audit";
import {
  computeCost,
  encodeProjectSegment,
  findSessionJsonlsSync,
  isLocalCommandEcho,
  seedMatchesSlug,
  sumTranscriptUsage,
} from "./cost";
import { lookupModelPricing, MODEL_PRICING, priceUsage } from "./cost-pricing";
import type { RunAttribution } from "./run-attribution-types";
import { computeTotals } from "./run-attribution-unit";
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

function assistant(model: string, usage: object, id?: string): object {
  return {
    type: "assistant",
    message: { ...(id ? { id } : {}), model, usage },
  };
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
    expect(encodeProjectSegment("/Users/me/code/flow")).toBe(
      "-Users-me-code-flow",
    );
  });

  it("maps dots and other non-alphanumerics to dashes like Claude Code", () => {
    expect(encodeProjectSegment("/Users/me/code/.flow-tmp/a_b")).toBe(
      "-Users-me-code--flow-tmp-a-b",
    );
  });

  it("handles paths without a leading slash", () => {
    expect(encodeProjectSegment("relative/path")).toBe("relative-path");
  });
});

describe(seedMatchesSlug, () => {
  it("matches the slug derived from the description after the colon", () => {
    expect(
      seedMatchesSlug(
        "Use the /flow-pipeline skill for: add CSV export",
        "add-csv-export",
      ),
    ).toBe(true);
  });

  it("rejects seeds without /flow-pipeline", () => {
    expect(seedMatchesSlug("just a normal message", "add-csv-export")).toBe(
      false,
    );
  });

  it("rejects when the slug doesn't match", () => {
    expect(
      seedMatchesSlug(
        "Use the /flow-pipeline skill for: something else",
        "add-csv-export",
      ),
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
    expect(
      seedMatchesSlug(`Use the /flow-pipeline skill for: ${desc}`, slug),
    ).toBe(true);
  });

  it("matches the resume-mode seed prompt format", () => {
    // `flow feature resume <slug>` seeds the supervisor with this prompt; the
    // resumed JSONL must still attribute back to the same pipeline so cost
    // counts both the pre-crash and post-resume sessions.
    expect(
      seedMatchesSlug(
        "Use the /flow-pipeline skill in --resume mode for: add-csv-export",
        "add-csv-export",
      ),
    ).toBe(true);
  });

  it("matches the new single-line REQUEST_FILE-bearing seed shape", () => {
    // Post-migration seed: the description no longer rides the seed at all,
    // so the old free-text-after-colon regex would capture the absolute
    // REQUEST_FILE path and never equal the slug — the bracket must be
    // matched directly.
    expect(
      seedMatchesSlug(
        "[pipeline-slug: add-csv-export] Use the /flow-pipeline skill. REQUEST_FILE: /Users/test/.flow/state/add-csv-export.request.md",
        "add-csv-export",
      ),
    ).toBe(true);
  });

  it("rejects the new seed shape when the bracketed slug differs", () => {
    expect(
      seedMatchesSlug(
        "[pipeline-slug: something-else] Use the /flow-pipeline skill. REQUEST_FILE: /Users/test/.flow/state/something-else.request.md",
        "add-csv-export",
      ),
    ).toBe(false);
  });
});

describe(computeCost, () => {
  it("returns hasData:false when no JSONL matches the slug", async () => {
    writeJsonl("foreign.jsonl", [
      seedEvent("Use the /flow-pipeline skill for: a different feature"),
    ]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost).toEqual({
      total: 0,
      byModel: {},
      unknownModels: [],
      hasData: false,
    });
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
    // `flow feature resume` spawns a fresh Claude session and writes a second
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

describe("repeated message.id de-duplication", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const repeated = () => [
    assistant("claude-sonnet-4-6", usage, "msg_1"),
    assistant("claude-sonnet-4-6", usage, "msg_1"),
    assistant("claude-sonnet-4-6", usage, "msg_1"),
    assistant("claude-sonnet-4-6", usage, "msg_2"),
    assistant("claude-sonnet-4-6", usage, "msg_2"),
  ];

  it("computeCost counts each distinct id once", async () => {
    writeJsonl("session.jsonl", [seedEvent(), ...repeated()]);
    const cost = await computeCost(state(), tmpRoot);
    expect(cost.total).toBeCloseTo(6, 6);
  });

  it("sumTranscriptUsage counts a 3x-repeated message once and agrees with computeCost", async () => {
    writeJsonl("session.jsonl", [seedEvent(), ...repeated()]);
    const usageSum = await sumTranscriptUsage(
      path.join(projectDir, "session.jsonl"),
    );
    expect(usageSum.input).toBe(2_000_000);
    expect(usageSum.total).toBe(2_000_000);
  });

  it("keeps the LAST line per message.id so output is the final value, in both summers", async () => {
    const mk = (output: number) => ({
      input_tokens: 1_000_000,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", mk(3), "msg_1"),
      assistant("claude-sonnet-4-6", mk(333), "msg_1"),
    ]);
    const usageSum = await sumTranscriptUsage(
      path.join(projectDir, "session.jsonl"),
    );
    expect(usageSum.output).toBe(333);
    expect(usageSum.input).toBe(1_000_000);
    const cost = await computeCost(state(), tmpRoot);
    // Sonnet: $3 input + 333 output tokens at $15/M.
    expect(cost.total).toBeCloseTo(3 + (333 * 15) / 1_000_000, 9);
  });

  it("counts id-less lines individually and ignores a last line without usage", async () => {
    const u = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const noUsage = assistant("claude-sonnet-4-6", u, "msg_1");
    delete (noUsage as { message: { usage?: unknown } }).message.usage;
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", u),
      assistant("claude-sonnet-4-6", u),
      assistant("claude-sonnet-4-6", u, "msg_1"),
      noUsage,
    ]);
    const usageSum = await sumTranscriptUsage(
      path.join(projectDir, "session.jsonl"),
    );
    expect(usageSum.input).toBe(30);
    expect(usageSum.output).toBe(15);
  });
});

describe(sumTranscriptUsage, () => {
  let scratchRoot: string;
  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cost-usage-"));
  });
  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("sums input/cache_creation/cache_read/output across assistant events and reports total + last model", async () => {
    const jsonlPath = path.join(scratchRoot, "session.jsonl");
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify(
          assistant("claude-sonnet-4-6", {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          }),
        ),
        JSON.stringify(
          assistant("claude-opus-4-7", {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          }),
        ),
      ].join("\n"),
    );
    const usage = await sumTranscriptUsage(jsonlPath);
    expect(usage).toEqual({
      input: 11,
      cache_creation: 22,
      cache_read: 33,
      output: 44,
      total: 110,
      model: "claude-opus-4-7",
      effortRuns: [["unknown", 2]],
    });
  });

  it("skips malformed lines without throwing", async () => {
    const jsonlPath = path.join(scratchRoot, "session.jsonl");
    fs.writeFileSync(
      jsonlPath,
      [
        "{not valid json",
        JSON.stringify(
          assistant("claude-sonnet-4-6", {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          }),
        ),
      ].join("\n"),
    );
    const usage = await sumTranscriptUsage(jsonlPath);
    expect(usage.input).toBe(5);
    expect(usage.model).toBe("claude-sonnet-4-6");
  });

  it("returns all zeros with model null and does not throw for a missing file", async () => {
    const usage = await sumTranscriptUsage(
      path.join(scratchRoot, "does-not-exist.jsonl"),
    );
    expect(usage).toEqual({
      input: 0,
      cache_creation: 0,
      cache_read: 0,
      output: 0,
      total: 0,
      model: null,
      effortRuns: [],
    });
  });

  it("reports ordered effort runs", async () => {
    const jsonlPath = path.join(projectDir, "eff.jsonl");
    fs.writeFileSync(
      jsonlPath,
      [
        { ...(assistant("claude-opus-5-5", {}, "a") as object), effort: "low" },
        {
          ...(assistant("claude-opus-5-5", {}, "b") as object),
          effort: "high",
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    expect((await sumTranscriptUsage(jsonlPath)).effortRuns).toEqual([
      ["low", 1],
      ["high", 1],
    ]);
  });
});

describe("/clear-aware session discovery", () => {
  const BRACKET =
    "[pipeline-slug: add-csv-export] Use the /flow-pipeline skill.";

  it("matches a session whose first lines are isMeta and a /clear echo", () => {
    writeJsonl("cleared.jsonl", [
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "meta" },
      },
      seedEvent("<command-name>/clear</command-name>\n<command-message>clear"),
      seedEvent("<local-command-stdout></local-command-stdout>"),
      seedEvent(BRACKET),
    ]);
    expect(findSessionJsonlsSync(projectDir, SLUG)).toEqual([
      path.join(projectDir, "cleared.jsonl"),
    ]);
  });

  it("finds the first real message behind a multi-chunk prefix", () => {
    const filler = { type: "attachment", blob: "x".repeat(200_000) };
    writeJsonl("big.jsonl", [filler, filler, seedEvent(BRACKET)]);
    expect(findSessionJsonlsSync(projectDir, SLUG)).toHaveLength(1);
  });

  it("does not match when the first real message names another slug", () => {
    writeJsonl("other.jsonl", [
      seedEvent("<command-name>/clear</command-name>"),
      seedEvent("[pipeline-slug: other] Use the /flow-pipeline skill."),
    ]);
    expect(findSessionJsonlsSync(projectDir, SLUG)).toEqual([]);
  });

  it("classifies echoes", () => {
    expect(isLocalCommandEcho({ isMeta: true })).toBe(true);
    expect(
      isLocalCommandEcho({ message: { content: "<command-name>/x" } }),
    ).toBe(true);
    expect(isLocalCommandEcho({ message: { content: "hello" } })).toBe(false);
  });
});

describe("price table", () => {
  it("prices 5m and 1h cache writes per bucket for opus-5-5", () => {
    const p = lookupModelPricing("claude-opus-5-5");
    expect(p).not.toBeNull();
    const usage = {
      cache_creation_input_tokens: 2_000_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 1_000_000,
      },
    };
    // $5 (5m) + $8 (1h)
    expect(priceUsage(usage, p!)).toBeCloseTo(13, 6);
  });

  it("prices all cache writes at the 5m rate when no split is present", () => {
    const p = MODEL_PRICING["claude-opus-5-5"];
    expect(
      priceUsage({ cache_creation_input_tokens: 1_000_000 }, p),
    ).toBeCloseTo(5, 6);
  });

  it("resolves a dated model id to its undated entry", () => {
    expect(lookupModelPricing("claude-opus-5-5-20261101")).toBe(
      MODEL_PRICING["claude-opus-5-5"],
    );
    expect(lookupModelPricing("claude-haiku-5-5")).toBeNull();
  });

  it("agrees with the spend audit's PRICES over the audit's keys", () => {
    for (const [model, [input, w5m, w1h, read, output]] of Object.entries(
      PRICES,
    )) {
      expect(MODEL_PRICING[model], model).toMatchObject({
        input,
        cacheCreation: w5m,
        cacheCreation1h: w1h,
        cacheRead: read,
        output,
      });
    }
  });

  it("keeps a 1h write rate of 2x input on the 4.x entries", () => {
    for (const id of ["claude-opus-4-7", "claude-sonnet-4-6"]) {
      expect(MODEL_PRICING[id].cacheCreation1h).toBe(
        MODEL_PRICING[id].input * 2,
      );
    }
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

describe("computeCost as a run-attribution projection", () => {
  const ONE_MTOK = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  function rowWith(sessionIds: string[], cost: number): RunAttribution {
    const sessions = sessionIds.map((id) => ({
      session_id: id,
      model: "claude-sonnet-4-6",
      runs: [["claude-sonnet-4-6", "low", 1]] as [string, string, number][],
      run_costs: [cost],
      turns: 1,
      tokens: {
        input: 1,
        cache_creation: 0,
        cache_read: 0,
        output: 0,
        total: 1,
      },
      cost_usd: cost,
    }));
    return {
      version: 1,
      slug: SLUG,
      pr: null,
      repo: REPO,
      sessions,
      spawns: [],
      delegated: [],
      totals: computeTotals(sessions, [], 0),
    };
  }

  it("prices a fully pruned pipeline from the latest row alone", async () => {
    const cost = await computeCost(state(), tmpRoot, rowWith(["gone"], 7));
    expect(cost.hasData).toBe(true);
    expect(cost.total).toBeCloseTo(7, 6);
    expect(cost.byModel["claude-sonnet-4-6"]).toBeCloseTo(7, 6);
  });

  it("sums a row session with an on-disk session for a partly pruned pipeline", async () => {
    writeJsonl("live.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", ONE_MTOK),
    ]);
    const cost = await computeCost(state(), tmpRoot, rowWith(["gone"], 7));
    // $7 from the pruned row session + $3 for 1M Sonnet 4.6 input tokens
    expect(cost.total).toBeCloseTo(10, 6);
  });

  it("keeps an empty row at hasData:false so the cell renders a dash", async () => {
    const cost = await computeCost(state(), tmpRoot, rowWith([], 0));
    expect(cost).toEqual({
      total: 0,
      byModel: {},
      unknownModels: [],
      hasData: false,
    });
  });

  it("counts sub-agent spend and lists unpriced models", async () => {
    writeJsonl("session.jsonl", [
      seedEvent(),
      assistant("claude-sonnet-4-6", ONE_MTOK),
    ]);
    const sub = path.join(projectDir, "session", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, "agent-1.jsonl"),
      [
        assistant("claude-opus-5-5", ONE_MTOK),
        assistant("claude-haiku-5-5", ONE_MTOK),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const cost = await computeCost(state(), tmpRoot);
    // $3 sonnet-4-6 + $4 opus-5-5; haiku-5-5 is unpriced
    expect(cost.total).toBeCloseTo(7, 6);
    expect(cost.unknownModels).toEqual(["claude-haiku-5-5"]);
  });
});
