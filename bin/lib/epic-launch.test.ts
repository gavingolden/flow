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

const EPIC_SLUG = "my-epic";
const POINTER =
  "Part of epic `my-epic` (feature `schema`) — design at `.flow/epics/my-epic/design.md`.";
const DESCRIPTION_WITH_POINTER = `add the watchlist schema\n\n${POINTER}`;

describe("buildFeatureCreateArgs", () => {
  it("no hints → feature create + pointer-appended description + --epic <epicSlug>/<id> + --slug <id>", () => {
    expect(buildFeatureCreateArgs(feat(), EPIC_SLUG)).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("autoMerge:false → --no-auto-merge before --epic/--slug", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { autoMerge: false } }),
        EPIC_SLUG,
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--no-auto-merge",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("autoMerge absent → no flag", () => {
    expect(
      buildFeatureCreateArgs(feat({ flowNewHints: {} }), EPIC_SLUG),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("autoMerge:true → no flag (true ≡ default)", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { autoMerge: true } }),
        EPIC_SLUG,
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("copilotReview:always → --copilot-review always before --epic/--slug", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { copilotReview: "always" } }),
        EPIC_SLUG,
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--copilot-review",
      "always",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("effort:high → --effort high before --epic/--slug", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { effort: "high" } }),
        EPIC_SLUG,
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--effort",
      "high",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("combined hints emit every flag in order, --epic before --slug", () => {
    expect(
      buildFeatureCreateArgs(
        feat({
          flowNewHints: {
            autoMerge: false,
            copilotReview: "never",
            effort: "max",
          },
        }),
        EPIC_SLUG,
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--no-auto-merge",
      "--copilot-review",
      "never",
      "--effort",
      "max",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("Story 5: emits --slug slugify(id) for an id that is already a valid slug", () => {
    const args = buildFeatureCreateArgs(
      feat({ id: "pokedex-page", description: "Re-skin the pokedex page" }),
      EPIC_SLUG,
    );
    expect(args.slice(-3)).toEqual(["--slug", "pokedex-page", "--tmux"]);
    expect(args.slice(3, 5)).toEqual(["--epic", "my-epic/pokedex-page"]);
  });

  it("Story 5: normalizes an id needing slugification into the --slug value (--epic keeps the raw id)", () => {
    const args = buildFeatureCreateArgs(
      feat({ id: "Search Page", description: "Re-skin the search page" }),
      EPIC_SLUG,
    );
    expect(args.slice(-3)).toEqual(["--slug", "search-page", "--tmux"]);
    expect(args.slice(3, 5)).toEqual(["--epic", "my-epic/Search Page"]);
  });

  describe("pointer-sentence auto-append", () => {
    it("appends the pointer sentence when the description lacks it", () => {
      const args = buildFeatureCreateArgs(feat(), EPIC_SLUG);
      expect(args[2]).toBe(DESCRIPTION_WITH_POINTER);
      expect(args[2].match(/Part of epic/g)).toHaveLength(1);
    });

    it("does not double-append when the description already carries the pointer", () => {
      const alreadyPointed = `add the watchlist schema\n\n${POINTER}`;
      const args = buildFeatureCreateArgs(
        feat({ description: alreadyPointed }),
        EPIC_SLUG,
      );
      expect(args[2]).toBe(alreadyPointed);
      expect(args[2].match(/Part of epic/g)).toHaveLength(1);
    });

    it("skips auto-append when the description carries a differently-worded pointer (designer-authored)", () => {
      const designerPointer =
        "add the watchlist schema\n\nPart of epic `my-epic` (feature `schema`) — design at `.flow/epics/my-epic/design.md`. Extra designer note.";
      const args = buildFeatureCreateArgs(
        feat({ description: designerPointer }),
        EPIC_SLUG,
      );
      expect(args[2]).toBe(designerPointer);
      expect(args[2].match(/Part of epic/g)).toHaveLength(1);
    });
  });

  // --- launch-time overrides (flow epic launch --model/--effort) ----------

  it("overrides.effort replaces hint effort — emits exactly one --effort", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { effort: "high" } }),
        EPIC_SLUG,
        { effort: "low" },
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--effort",
      "low",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("overrides.model appends --model (no manifest hint equivalent)", () => {
    expect(
      buildFeatureCreateArgs(feat(), EPIC_SLUG, { model: "opus" }),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--model",
      "opus",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("combined overrides.effort + overrides.model both reach the argv", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { autoMerge: false } }),
        EPIC_SLUG,
        { model: "fable", effort: "xhigh" },
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--no-auto-merge",
      "--effort",
      "xhigh",
      "--model",
      "fable",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("no overrides === current behavior (hint effort still emitted)", () => {
    expect(
      buildFeatureCreateArgs(
        feat({ flowNewHints: { effort: "high" } }),
        EPIC_SLUG,
      ),
    ).toEqual([
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--effort",
      "high",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
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
    const result = launchFeature(feat(), { spawn, epicSlug: EPIC_SLUG });
    expect(result).toEqual({ ok: true, slug: "watchlist-schema-2" });
    // Spawned the bare `flow` with the built argv (now carrying --epic and --slug).
    expect(spawn).toHaveBeenCalledWith("flow", [
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });

  it("falls back to slugify(id) when no flow:<slug> line is present (D2-B)", () => {
    // The fallback must track the id-derived slug --slug requested, not the
    // description (which no longer reflects the launched window/state).
    const spawn = vi.fn<SpawnFn>(() => ok("some unexpected output\n"));
    const result = launchFeature(
      feat({ id: "watchlist-schema", description: "Add the watchlist schema" }),
      { spawn, epicSlug: EPIC_SLUG },
    );
    expect(result).toEqual({ ok: true, slug: "watchlist-schema" });
  });

  it("surfaces a non-zero exit (windowExists collision) as an error result", () => {
    const spawn = vi.fn<SpawnFn>(() => ({
      status: 1,
      stdout: "",
      stderr: "flow feature create: window 'flow:schema' already exists.",
    }));
    const result = launchFeature(feat(), { spawn, epicSlug: EPIC_SLUG });
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
    const result = launchFeature(feat(), { spawn, epicSlug: EPIC_SLUG });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/ENOENT/);
  });

  it("threads opts.overrides into the spawned argv, --slug still last", () => {
    const spawn = vi.fn<SpawnFn>(() => ok("flow:watchlist-schema-2\n"));
    const result = launchFeature(feat(), {
      spawn,
      epicSlug: EPIC_SLUG,
      overrides: { model: "opus", effort: "low" },
    });
    expect(result).toEqual({ ok: true, slug: "watchlist-schema-2" });
    expect(spawn).toHaveBeenCalledWith("flow", [
      "feature",
      "create",
      DESCRIPTION_WITH_POINTER,
      "--effort",
      "low",
      "--model",
      "opus",
      "--epic",
      "my-epic/schema",
      "--slug",
      "schema",
      "--tmux",
    ]);
  });
});

describe("launcher guard + deterministic --tmux append", () => {
  it("buildFeatureCreateArgs always appends --tmux so the child launches under tmux", () => {
    const args = buildFeatureCreateArgs(
      {
        id: "feature-a",
        title: "Feature A",
        description: "do a thing",
        dependsOn: [],
      },
      "my-epic",
    );
    expect(args).toContain("--tmux");
  });

  it("launchFeature refuses with the named notice when tmux is off PATH (spawn never fires)", () => {
    const spawn = vi.fn();
    const r = launchFeature(
      {
        id: "feature-a",
        title: "Feature A",
        description: "do a thing",
        dependsOn: [],
      },
      { spawn, epicSlug: "my-epic", tmuxOnPath: () => false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(
        "epic orchestration requires the tmux launcher",
      );
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launchFeature proceeds when tmux is on PATH", () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: "flow:feature-a\n",
      stderr: "",
    }));
    const r = launchFeature(
      {
        id: "feature-a",
        title: "Feature A",
        description: "do a thing",
        dependsOn: [],
      },
      { spawn, epicSlug: "my-epic", tmuxOnPath: () => true },
    );
    expect(r).toEqual({ ok: true, slug: "feature-a" });
  });
});
