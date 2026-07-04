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
  it("no hints → feature create + description + --slug <id>", () => {
    expect(buildFeatureCreateArgs(feat())).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--slug",
      "schema",
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
      "--slug",
      "schema",
    ]);
  });

  it("autoMerge absent → no flag", () => {
    expect(buildFeatureCreateArgs(feat({ flowNewHints: {} }))).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--slug",
      "schema",
    ]);
  });

  it("autoMerge:true → no flag (true ≡ default)", () => {
    expect(
      buildFeatureCreateArgs(feat({ flowNewHints: { autoMerge: true } })),
    ).toEqual([
      "feature",
      "create",
      "add the watchlist schema",
      "--slug",
      "schema",
    ]);
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
      "--slug",
      "schema",
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
      "--slug",
      "schema",
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
      "--slug",
      "schema",
    ]);
  });

  it("Story 5: emits --slug slugify(id) for an id that is already a valid slug", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ id: "pokedex-page", description: "Re-skin the pokedex page" }),
      ),
    ).toEqual([
      "feature",
      "create",
      "Re-skin the pokedex page",
      "--slug",
      "pokedex-page",
    ]);
  });

  it("Story 5: normalizes an id needing slugification into the --slug value", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ id: "Search Page", description: "Re-skin the search page" }),
      ),
    ).toEqual([
      "feature",
      "create",
      "Re-skin the search page",
      "--slug",
      "search-page",
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
    // Spawned the bare `flow` with the built argv (now carrying --slug <id>).
    expect(spawn).toHaveBeenCalledWith("flow", [
      "feature",
      "create",
      "add the watchlist schema",
      "--slug",
      "schema",
    ]);
  });

  it("falls back to slugify(id) when no flow:<slug> line is present (D2-B)", () => {
    // The fallback must track the id-derived slug --slug requested, not the
    // description (which no longer reflects the launched window/state).
    const spawn = vi.fn<SpawnFn>(() => ok("some unexpected output\n"));
    const result = launchFeature(
      feat({ id: "watchlist-schema", description: "Add the watchlist schema" }),
      { spawn },
    );
    expect(result).toEqual({ ok: true, slug: "watchlist-schema" });
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
