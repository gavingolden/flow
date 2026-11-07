import { describe, expect, it } from "vitest";
import { deriveRoutePatterns, deriveRoutes } from "./ui-route-infer";

// One changed file → its single derived route (or undefined when none).
function route(file: string): string | undefined {
  return deriveRoutes([file])[0];
}

describe("deriveRoutes — Story 2 stack-agnostic table", () => {
  it.each([
    ["src/routes/about/+page.svelte", "/about"], // SvelteKit
    ["app/dashboard/page.tsx", "/dashboard"], // Next app-router
    ["app/(marketing)/pricing/page.tsx", "/pricing"], // group-strip
    ["routes/settings.tsx", "/settings"], // generic file-per-route
    ["app/routes/reports.tsx", "/reports"], // Remix app/routes
  ])("maps %s → %s", (file, expected) => {
    expect(route(file)).toBe(expected);
  });

  it.each([
    ["app/blog/[slug]/page.tsx"], // dynamic leaf → skip
    ["src/lib/components/Button.svelte"], // non-route component → skip
    ["app/routes/posts.$id.tsx"], // Remix dynamic flat → skip
    ["src/routes/blog/[slug]/+page.svelte"], // SvelteKit dynamic → skip
  ])("emits no route for %s", (file) => {
    expect(route(file)).toBeUndefined();
  });
});

describe("deriveRoutes — edge cases", () => {
  it("root +page.svelte maps to /", () => {
    expect(route("src/routes/+page.svelte")).toBe("/");
  });

  it("root Next page maps to /", () => {
    expect(route("app/page.tsx")).toBe("/");
  });

  it("index.* is boilerplate: dir is the route", () => {
    expect(route("src/routes/blog/index.tsx")).toBe("/blog");
  });

  it("nested route groups are stripped", () => {
    expect(route("app/(marketing)/(promo)/sale/page.tsx")).toBe("/sale");
  });

  it("Remix flat dotted route splits on '.'", () => {
    expect(route("app/routes/settings.profile.tsx")).toBe("/settings/profile");
  });

  it("Remix app/routes wins over the outer app root", () => {
    expect(route("app/routes/about/+page.svelte")).toBe("/about");
  });

  it("a route dir literally named `app` keeps its leading segment", () => {
    expect(route("src/routes/app/dashboard/+page.svelte")).toBe(
      "/app/dashboard",
    );
    expect(route("src/routes/app/+page.svelte")).toBe("/app");
  });

  it("a Next route.ts Route Handler (JSON API) derives no route", () => {
    expect(route("app/api/users/route.ts")).toBeUndefined();
  });

  it("a bare stylesheet under routes/ derives no route", () => {
    expect(route("src/routes/about/styles.css")).toBeUndefined();
  });

  it("a layout file derives no route", () => {
    expect(route("src/routes/+layout.svelte")).toBeUndefined();
  });

  it("a server endpoint derives no route", () => {
    expect(route("src/routes/api/+server.ts")).toBeUndefined();
  });

  it("a PascalCase colocated component under routes/ derives no route", () => {
    expect(route("src/routes/about/Modal.svelte")).toBeUndefined();
  });

  it("a file outside any routes/app tree derives no route", () => {
    expect(route("src/lib/util.ts")).toBeUndefined();
  });

  it("de-duplicates and preserves order across many files", () => {
    const routes = deriveRoutes([
      "src/routes/about/+page.svelte",
      "src/routes/about/Modal.svelte", // no route
      "app/dashboard/page.tsx",
      "src/routes/about/styles.css", // no route
      "app/dashboard/page.tsx", // dup
    ]);
    expect(routes).toEqual(["/about", "/dashboard"]);
  });

  it("empty input yields no routes", () => {
    expect(deriveRoutes([])).toEqual([]);
  });
});

describe("deriveRoutePatterns", () => {
  const matches = (file: string, url: string): boolean =>
    deriveRoutePatterns([file]).some((m) => m(url));

  it("a [param] segment matches exactly one segment", () => {
    const file = "src/routes/analysis/[symbol]/+page.svelte";
    expect(matches(file, "/analysis/AAPL")).toBe(true);
    expect(matches(file, "/analysis/AAPL?tab=x")).toBe(true);
    expect(matches(file, "/analysis")).toBe(false);
    expect(matches(file, "/analysis/AAPL/extra")).toBe(false);
    expect(matches(file, "/dashboard")).toBe(false);
  });

  it("a [...rest] segment matches any tail", () => {
    const file = "src/routes/docs/[...path]/+page.svelte";
    expect(matches(file, "/docs/a/b/c")).toBe(true);
    expect(matches(file, "/guides/a")).toBe(false);
  });

  it("a [[optional]] segment matches with or without the segment", () => {
    const file = "src/routes/blog/[[page]]/+page.svelte";
    expect(matches(file, "/blog")).toBe(true);
    expect(matches(file, "/blog/2")).toBe(true);
    expect(matches(file, "/blog/2/3")).toBe(false);
  });

  it("a [id=matcher] segment matches one segment", () => {
    const file = "src/routes/user/[id=integer]/+page.svelte";
    expect(matches(file, "/user/42")).toBe(true);
  });

  it("route groups do not count as URL segments", () => {
    const file = "app/(shop)/items/[sku]/page.tsx";
    expect(matches(file, "/items/abc")).toBe(true);
  });

  it("a route loader names the same pattern as its page", () => {
    expect(
      matches("src/routes/analysis/[symbol]/+page.server.ts", "/analysis/X"),
    ).toBe(true);
  });

  it("static routes, layouts and non-route files yield no matcher", () => {
    expect(deriveRoutePatterns(["src/routes/about/+page.svelte"])).toEqual([]);
    expect(deriveRoutePatterns(["src/routes/[id]/+layout.svelte"])).toEqual([]);
    expect(deriveRoutePatterns(["src/lib/util.ts"])).toEqual([]);
  });

  // Named non-goals: Remix `$slug` and generic `:id` dynamic segments are not
  // recognised, so they contribute no matcher rather than a wrong one.
  it("Remix $slug and generic :id segments are non-goals", () => {
    expect(deriveRoutePatterns(["app/routes/posts/$slug.tsx"])).toEqual([]);
    expect(deriveRoutePatterns(["routes/:id/page.tsx"])).toEqual([]);
  });
});
