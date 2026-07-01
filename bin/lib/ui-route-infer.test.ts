import { describe, expect, it } from "vitest";
import { deriveRoutes } from "./ui-route-infer";

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
