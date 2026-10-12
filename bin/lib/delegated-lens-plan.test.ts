import { describe, expect, it } from "vitest";
import { DELEGATABLE_LENSES, type DelegatableLens } from "./delegate-models";
import { planLensRoutes } from "./delegated-lens-plan";

const base = {
  lenses: [...DELEGATABLE_LENSES],
  variant: "Claude Opus 5.5 (High)" as string | null,
  delegated: ["bug-detection", "pattern-consistency"] as DelegatableLens[],
  taskModelFor: () => "opus" as string | null,
  cooldownLive: false,
};

const routeOf = (
  routes: ReturnType<typeof planLensRoutes>,
  lens: DelegatableLens,
) => routes.find((r) => r.lens === lens)!;

describe("planLensRoutes", () => {
  it("routes delegated lenses to agy and the rest to task/not-in-delegated-set", () => {
    const routes = planLensRoutes(base);
    expect(routeOf(routes, "bug-detection")).toEqual({
      lens: "bug-detection",
      route: "agy",
    });
    expect(routeOf(routes, "security")).toEqual({
      lens: "security",
      route: "task",
      reason: "not-in-delegated-set",
    });
  });

  it("covers exactly the requested lenses, in order", () => {
    const lenses: DelegatableLens[] = ["test-coverage", "bug-detection"];
    const routes = planLensRoutes({ ...base, lenses });
    expect(routes.map((r) => r.lens)).toEqual(lenses);
  });

  it("delegation-off wins when the variant is null", () => {
    const routes = planLensRoutes({
      ...base,
      variant: null,
      cooldownLive: true,
    });
    expect(
      routes.every((r) => r.route === "task" && r.reason === "delegation-off"),
    ).toBe(true);
  });

  it("a Fable session keeps bug-detection on task (Story 2)", () => {
    const routes = planLensRoutes({
      ...base,
      taskModelFor: (l) => (l === "bug-detection" ? "fable" : "opus"),
    });
    expect(routeOf(routes, "bug-detection")).toEqual({
      lens: "bug-detection",
      route: "task",
      reason: "fable-session-keeps-task",
    });
    expect(routeOf(routes, "pattern-consistency").route).toBe("agy");
  });

  it.each(["Fable", "claude-fable-1", "FABLE"])(
    "matches the Fable model case-insensitively (%s)",
    (model) => {
      const routes = planLensRoutes({ ...base, taskModelFor: () => model });
      expect(routeOf(routes, "bug-detection")).toMatchObject({
        reason: "fable-session-keeps-task",
      });
    },
  );

  it.each([null, ""])("treats an unknown model (%j) as non-Fable", (model) => {
    const routes = planLensRoutes({ ...base, taskModelFor: () => model });
    expect(routeOf(routes, "bug-detection").route).toBe("agy");
  });

  it("a live cooldown sends every delegated lens to task/agy-cooldown", () => {
    const routes = planLensRoutes({ ...base, cooldownLive: true });
    expect(routeOf(routes, "bug-detection")).toEqual({
      lens: "bug-detection",
      route: "task",
      reason: "agy-cooldown",
    });
    expect(routeOf(routes, "security")).toMatchObject({
      reason: "not-in-delegated-set",
    });
  });

  it("fable-session-keeps-task outranks agy-cooldown", () => {
    const routes = planLensRoutes({
      ...base,
      cooldownLive: true,
      taskModelFor: () => "fable",
    });
    expect(routeOf(routes, "bug-detection")).toMatchObject({
      reason: "fable-session-keeps-task",
    });
  });
});
