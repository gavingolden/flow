import { describe, expect, it } from "vitest";
import { resolveManagerModelEffort } from "./epic-manager-model";

const cfg = (raw: unknown) => () => raw;

describe("resolveManagerModelEffort", () => {
  it("defaults to opus/high with an empty featureFallback", () => {
    expect(resolveManagerModelEffort({ read: cfg({}) })).toEqual({
      model: "opus",
      effort: "high",
      featureFallback: {},
    });
  });

  it("config.models.manager / config.efforts.manager beat the default but never reach featureFallback", () => {
    expect(
      resolveManagerModelEffort({
        read: cfg({
          models: { manager: "sonnet" },
          efforts: { manager: "low" },
        }),
      }),
    ).toEqual({ model: "sonnet", effort: "low", featureFallback: {} });
  });

  it("typed flags beat config and become the featureFallback", () => {
    expect(
      resolveManagerModelEffort({
        flagModel: "haiku",
        flagEffort: "medium",
        read: cfg({
          models: { manager: "sonnet" },
          efforts: { manager: "low" },
        }),
      }),
    ).toEqual({
      model: "haiku",
      effort: "medium",
      featureFallback: { model: "haiku", effort: "medium" },
    });
  });

  it("resolves each axis independently", () => {
    expect(
      resolveManagerModelEffort({
        flagEffort: "max",
        read: cfg({ models: { manager: "fable" } }),
      }),
    ).toEqual({
      model: "fable",
      effort: "max",
      featureFallback: { effort: "max" },
    });
  });

  it("ignores an invalid configured alias or level", () => {
    expect(
      resolveManagerModelEffort({
        read: cfg({
          models: { manager: "gpt" },
          efforts: { manager: "extreme" },
        }),
      }),
    ).toMatchObject({ model: "opus", effort: "high" });
  });
});
