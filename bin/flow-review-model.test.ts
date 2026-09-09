import { describe, expect, it } from "vitest";
import { run, type FlowReviewModelDeps } from "./flow-review-model";
import type { ReadConfigFile } from "./lib/models-config";
import type { PipelineState } from "./lib/state";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

const st = (partial: Partial<PipelineState>): PipelineState =>
  ({
    slug: "s",
    phase: "planning",
    repo: "/r",
    updatedAt: "",
    ...partial,
  }) as PipelineState;

function capture(): {
  deps: Pick<FlowReviewModelDeps, "stdout" | "stderr">;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    out,
    err,
  };
}

function runWith(
  argv: string[],
  opts: {
    config?: unknown;
    state?: PipelineState | null;
  } = {},
): { code: number; out: string[]; err: string[] } {
  const { deps, out, err } = capture();
  const code = run(argv, {
    ...deps,
    read: reader(opts.config ?? {}),
    loadState: () => opts.state ?? null,
    resolveSlug: () => "s",
  });
  return { code, out, err };
}

describe("flow-review-model", () => {
  it("an explicit models.reviewLenses.<lens> wins over everything else", () => {
    const { code, out } = runWith(["bug-detection"], {
      config: {
        models: {
          review: "sonnet",
          reviewLenses: { "bug-detection": "haiku" },
        },
      },
      state: st({ modelReview: "opus", model: "fable" }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["haiku"]);
  });

  it("state.modelReview wins over config.models.review", () => {
    const { code, out } = runWith(["security"], {
      config: { models: { review: "sonnet" } },
      state: st({ modelReview: "opus" }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["opus"]);
  });

  it("config.models.review wins over the session model", () => {
    const { code, out } = runWith(["performance"], {
      config: { models: { review: "haiku" } },
      state: st({ model: "fable" }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["haiku"]);
  });

  it("a fable session model resolves to opus with a source naming the cap (accidental-fable guard)", () => {
    const { code, out } = runWith(["pattern-consistency"], {
      state: st({ model: "fable" }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["opus"]);

    const jsonResult = runWith(["pattern-consistency", "--json"], {
      state: st({ model: "fable" }),
    });
    const parsed = JSON.parse(jsonResult.out[0]);
    expect(parsed).toEqual({
      lens: "pattern-consistency",
      model: "opus",
      source: expect.stringContaining("capped"),
    });
  });

  it("a sonnet session model resolves to sonnet, NOT escalated to opus (regression guard)", () => {
    const { code, out } = runWith(["test-coverage"], {
      state: st({ model: "sonnet" }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["sonnet"]);
  });

  it("absent config and absent state print nothing and exit 0", () => {
    const { code, out } = runWith(["supply-chain"], {});
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it("an unknown lens exits 2", () => {
    const { code, err } = runWith(["not-a-real-lens"], {});
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown lens/);
    expect(err.join("\n")).toContain("bug-detection");
    expect(err.join("\n")).toContain("intent-guess");
  });

  it("--json emits {lens, model, source}", () => {
    const { code, out } = runWith(["intent-guess", "--json"], {
      config: { models: { reviewLenses: { "intent-guess": "haiku" } } },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out[0])).toEqual({
      lens: "intent-guess",
      model: "haiku",
      source: expect.stringContaining("reviewLenses"),
    });
  });
});
