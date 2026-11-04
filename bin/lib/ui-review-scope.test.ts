import { describe, expect, it } from "vitest";
import {
  deriveReviewTargets,
  hasUiReviewTargetsSection,
  isExcludedFromUiReview,
  parseUiReviewTargets,
  uiReviewRequired,
} from "./ui-review-scope";

describe("uiReviewRequired", () => {
  it("is true for a component under a components tree", () => {
    const r = uiReviewRequired([
      "src/lib/components/watchlist/CompanyAnalysisPanel.svelte",
    ]);
    expect(r.required).toBe(true);
    expect(r.uiFiles).toHaveLength(1);
  });

  it("is false for tests, stubs and type declarations only", () => {
    const r = uiReviewRequired([
      "src/lib/components/x/X.svelte.test.ts",
      "src/lib/__stubs__/H.svelte",
      "foo.d.ts",
    ]);
    expect(r.required).toBe(false);
    expect(r.ignored).toHaveLength(3);
  });

  it("is true for a one-line stylesheet change — no size threshold", () => {
    expect(uiReviewRequired(["src/app.css"]).required).toBe(true);
  });

  it("is true for a Svelte runes module on its own", () => {
    expect(uiReviewRequired(["src/lib/stores/stage.svelte.ts"]).required).toBe(
      true,
    );
  });

  it.each([
    "src/routes/a/+page.ts",
    "src/routes/a/+page.server.ts",
    "src/routes/+layout.ts",
    "src/routes/+layout.server.js",
    "tailwind.config.ts",
    "web/tailwind.config.js",
    "src/Button.tsx",
    "src/x.vue",
    "src/x.scss",
    "src/x.sass",
    "src/x.less",
    "src/x.jsx",
  ])("counts %s as render-bearing", (file) => {
    expect(uiReviewRequired([file]).required).toBe(true);
  });

  it.each([
    "src/lib/util.ts",
    "README.md",
    "src/lib/Thing.stories.svelte",
    "src/lib/__tests__/Thing.svelte",
    "src/lib/__mocks__/Thing.svelte",
    "src/lib/Thing.spec.tsx",
    "src/routes/a/+page.test.ts",
    "src/routes/a/+server.ts",
  ])("does not count %s", (file) => {
    expect(uiReviewRequired([file]).required).toBe(false);
  });

  it("an empty diff does not require a review", () => {
    expect(uiReviewRequired([]).required).toBe(false);
  });

  it("exposes the exclusion rule for reuse", () => {
    expect(isExcludedFromUiReview("a/b.test.svelte")).toBe(true);
    expect(isExcludedFromUiReview("a/b.svelte")).toBe(false);
  });
});

describe("parseUiReviewTargets", () => {
  const plan = [
    "# PRD",
    "## UI review targets",
    "",
    "- `/analysis/AVGO` — empty state, a symbol with no numbers",
    "- `http://localhost:5173/dashboard?tab=1` — default tab",
    "- `/settings`",
    "- `not-a-path` — ignored",
    "",
    "## Next section",
    "- `/should-not-parse` — after the section",
  ].join("\n");

  it("parses path, state and source from each bullet", () => {
    expect(parseUiReviewTargets(plan)).toEqual([
      {
        route: "/analysis/AVGO",
        state: "empty state, a symbol with no numbers",
        source: "plan",
      },
      { route: "/dashboard?tab=1", state: "default tab", source: "plan" },
      { route: "/settings", state: null, source: "plan" },
    ]);
  });

  it("returns nothing when the section is absent", () => {
    expect(parseUiReviewTargets("# PRD\n- `/x` — y")).toEqual([]);
    expect(hasUiReviewTargetsSection("# PRD")).toBe(false);
    expect(hasUiReviewTargetsSection(plan)).toBe(true);
  });
});

describe("deriveReviewTargets", () => {
  const planTarget = {
    route: "/analysis/AVGO",
    state: "empty",
    source: "plan" as const,
  };

  it("puts plan targets first", () => {
    const t = deriveReviewTargets({
      changedFiles: ["src/routes/about/+page.svelte"],
      planTargets: [planTarget],
      manifestRoutes: [],
    });
    expect(t[0]).toEqual(planTarget);
    expect(t[1]).toEqual({
      route: "/about",
      state: null,
      source: "route-file",
    });
  });

  it("matches manifest routes against a changed dynamic route, not others", () => {
    const t = deriveReviewTargets({
      changedFiles: ["src/routes/analysis/[symbol]/+page.svelte"],
      planTargets: [],
      manifestRoutes: ["/analysis/AAPL", "/dashboard"],
    });
    expect(t.map((x) => x.route)).toEqual(["/analysis/AAPL"]);
    expect(t[0].source).toBe("manifest-match");
    expect(t[0].state).toBeNull();
  });

  it("has no generic manifest fallback for a component-only diff", () => {
    const t = deriveReviewTargets({
      changedFiles: ["src/lib/components/Panel.svelte"],
      planTargets: [],
      manifestRoutes: ["/dashboard", "/analysis/AAPL"],
    });
    expect(t).toEqual([]);
  });

  it("de-duplicates by route and caps at three", () => {
    const t = deriveReviewTargets({
      changedFiles: [
        "src/routes/a/+page.svelte",
        "src/routes/b/+page.svelte",
        "src/routes/c/+page.svelte",
      ],
      planTargets: [
        { route: "/a", state: "x", source: "plan" },
        { route: "/z", state: null, source: "plan" },
      ],
      manifestRoutes: [],
    });
    expect(t.map((x) => x.route)).toEqual(["/a", "/z", "/b"]);
    expect(t[0].source).toBe("plan");
  });
});
