import { describe, expect, it, vi } from "vitest";
import {
  buildFeatureCreateArgs,
  launchFeature,
  type SpawnFn,
  type SpawnResult,
} from "./epic-launch";
import type { Feature } from "./epic-manifest-schema";

function feat(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "schema",
    title: "Schema",
    description: "add the watchlist schema",
    dependsOn: [],
    ...overrides,
  };
}

const ok = (stdout: string): SpawnResult => ({ status: 0, stdout, stderr: "" });

describe("buildFeatureCreateArgs", () => {
  it("no hints → just feature create + description", () => {
    expect(buildFeatureCreateArgs(feat())).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
    ]);
  });

  it("autoMerge:false → --no-auto-merge", () => {
    expect(
      buildFeatureCreateArgs(feat({ flowNewHints: { autoMerge: false } })),
    ).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--no-auto-merge",
    ]);
  });

  it("autoMerge absent → no flag", () => {
    expect(buildFeatureCreateArgs(feat({ flowNewHints: {} }))).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
    ]);
  });

  it("autoMerge:true → no flag (true ≡ default)", () => {
    expect(
      buildFeatureCreateArgs(feat({ flowNewHints: { autoMerge: true } })),
    ).toEqual(["feature", "create", "add the watchlist schema"]);
  });

  it("copilotReview:always → --copilot-review always", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { copilotReview: "always" } }),
      ),
    ).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--copilot-review",
      "always",
    ]);
  });

  it("effort:high → --effort high", () => {
    expect(
      buildFeatureCreateArgs(feat({ flowNewHints: { effort: "high" } })),
    ).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--effort",
      "high",
    ]);
  });

  it("combined hints emit every flag in order", () => {
    expect(
      buildFeatureCreateArgs(
        feat({
          flowNewHints: {
            autoMerge: false,
            copilotReview: "never",
            effort: "max",
          },
        }),
      ),
    ).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--no-auto-merge",
      "--copilot-review",
      "never",
      "--effort",
      "max",
    ]);
  });
});

describe("launchFeature", () => {
  it("parses the minted slug from the flow:<slug> stdout first line", () => {
    const spawn = vi.fn<SpawnFn>(() =>
      ok(
        "flow:watchlist-schema-2\nflow feature create: created — attach with ...\n",
      ),
    );
    const result = launchFeature(feat(), { spawn });
    expect(result).toEqual({ ok: true, slug: "watchlist-schema-2" });
    // Spawned the bare `flow` with the built argv.
    expect(spawn).toHaveBeenCalledWith("flow", [
      "feature",
      "create",
      "add the watchlist schema",
    ]);
  });

  it("falls back to slugify(description) when no flow:<slug> line is present", () => {
    const spawn = vi.fn<SpawnFn>(() => ok("some unexpected output\n"));
    const result = launchFeature(
      feat({ description: "Add the watchlist schema" }),
      { spawn },
    );
    expect(result).toEqual({ ok: true, slug: "add-watchlist-schema" });
  });

  it("surfaces a non-zero exit (windowExists collision) as an error result", () => {
    const spawn = vi.fn<SpawnFn>(() => ({
      status: 1,
      stdout: "",
      stderr: "flow feature create: window 'flow:schema' already exists.",
    }));
    const result = launchFeature(feat(), { spawn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already exists/);
  });

  it("surfaces a null status (spawn failure) as an error result, not a swallow", () => {
    const spawn = vi.fn<SpawnFn>(() => ({
      status: null,
      stdout: "",
      stderr: "spawn flow ENOENT",
    }));
    const result = launchFeature(feat(), { spawn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/ENOENT/);
  });
});
