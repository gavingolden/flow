import { describe, expect, it, vi } from "vitest";
import {
  buildFlowNewArgs,
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

describe("buildFlowNewArgs", () => {
  it("no hints → just new + description", () => {
    expect(buildFlowNewArgs(feat())).toEqual([
      "new",
      "add the watchlist schema",
    ]);
  });

  it("autoMerge:false → --no-auto-merge", () => {
    expect(
      buildFlowNewArgs(feat({ flowNewHints: { autoMerge: false } })),
    ).toEqual(["new", "add the watchlist schema", "--no-auto-merge"]);
  });

  it("autoMerge absent → no flag", () => {
    expect(buildFlowNewArgs(feat({ flowNewHints: {} }))).toEqual([
      "new",
      "add the watchlist schema",
    ]);
  });

  it("autoMerge:true → no flag (true ≡ default)", () => {
    expect(
      buildFlowNewArgs(feat({ flowNewHints: { autoMerge: true } })),
    ).toEqual(["new", "add the watchlist schema"]);
  });

  it("copilotReview:always → --copilot-review always", () => {
    expect(
      buildFlowNewArgs(feat({ flowNewHints: { copilotReview: "always" } })),
    ).toEqual([
      "new",
      "add the watchlist schema",
      "--copilot-review",
      "always",
    ]);
  });

  it("effort:high → --effort high", () => {
    expect(
      buildFlowNewArgs(feat({ flowNewHints: { effort: "high" } })),
    ).toEqual(["new", "add the watchlist schema", "--effort", "high"]);
  });

  it("combined hints emit every flag in order", () => {
    expect(
      buildFlowNewArgs(
        feat({
          flowNewHints: {
            autoMerge: false,
            copilotReview: "never",
            effort: "max",
          },
        }),
      ),
    ).toEqual([
      "new",
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
      ok("flow:watchlist-schema-2\nflow new: created — attach with ...\n"),
    );
    const result = launchFeature(feat(), { spawn });
    expect(result).toEqual({ ok: true, slug: "watchlist-schema-2" });
    // Spawned the bare `flow` with the built argv.
    expect(spawn).toHaveBeenCalledWith("flow", [
      "new",
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
      stderr: "flow new: window 'flow:schema' already exists.",
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
