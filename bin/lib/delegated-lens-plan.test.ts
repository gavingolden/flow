import { describe, expect, it } from "vitest";
import { DELEGATABLE_LENSES, type DelegatableLens } from "./delegate-models";
import { DEADLINE_GRACE_MS, KILL_GRACE_MS } from "./agy-guard";
import {
  HELPER_BUDGET_MS,
  MIN_REROUTE_MS,
  REROUTE_SLACK_MS,
  planLensRoutes,
  rerouteTask,
  rerouteTimeout,
  shouldReroute,
} from "./delegated-lens-plan";

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

describe("rerouteTimeout", () => {
  it("slack covers the agy-guard grace constants plus margins", () => {
    expect(REROUTE_SLACK_MS).toBe(
      DEADLINE_GRACE_MS + KILL_GRACE_MS + 5_000 + 10_000,
    );
    expect(REROUTE_SLACK_MS).toBe(50_000);
  });

  it("caps at the 8 minute lens budget when the helper just started", () => {
    expect(rerouteTimeout(0)).toBe("480s");
  });

  it("shrinks as the helper budget is spent", () => {
    expect(rerouteTimeout(100_000)).toBe("420s");
    expect(rerouteTimeout(HELPER_BUDGET_MS - REROUTE_SLACK_MS - 240_000)).toBe(
      "240s",
    );
  });

  it("returns null once under the minimum remains after slack", () => {
    const edge = HELPER_BUDGET_MS - REROUTE_SLACK_MS - MIN_REROUTE_MS;
    expect(rerouteTimeout(edge)).toBe("180s");
    expect(rerouteTimeout(edge + 1)).toBeNull();
    expect(rerouteTimeout(HELPER_BUDGET_MS)).toBeNull();
  });
});

describe("shouldReroute", () => {
  it("re-runs only a content-filtered Claude primary", () => {
    expect(
      shouldReroute("Claude Opus 5.5 (High)", "agy-content-filtered"),
    ).toBe(true);
  });

  it("never re-runs a Gemini primary", () => {
    expect(shouldReroute("Gemini 4 Argon (High)", "agy-content-filtered")).toBe(
      false,
    );
  });

  it("never re-runs other failure reasons", () => {
    expect(shouldReroute("Claude Opus 5.5 (High)", "agy-quota-exhausted")).toBe(
      false,
    );
    expect(shouldReroute("Claude Opus 5.5 (High)", "output-unparseable")).toBe(
      false,
    );
  });
});

describe("rerouteTask", () => {
  it("prefixes the lens name", () => {
    expect(rerouteTask("bug-detection")).toBe("agy-reroute-bug-detection");
  });
});
