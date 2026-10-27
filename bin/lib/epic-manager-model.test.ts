import { describe, expect, it } from "vitest";
import { resolveManagerModelEffort } from "./epic-manager-model";

describe("resolveManagerModelEffort", () => {
  it("defaults to opus/high with an empty featureFallback", () => {
    expect(resolveManagerModelEffort({ read: () => undefined })).toEqual({
      model: "opus",
      effort: "high",
      featureFallback: {},
    });
  });

  it("config beats the default but never lands in featureFallback", () => {
    const read = () => ({
      models: { manager: "sonnet" },
      efforts: { manager: "medium" },
    });
    expect(resolveManagerModelEffort({ read })).toEqual({
      model: "sonnet",
      effort: "medium",
      featureFallback: {},
    });
  });

  it("flags beat config and populate featureFallback", () => {
    const read = () => ({
      models: { manager: "sonnet" },
      efforts: { manager: "medium" },
    });
    expect(
      resolveManagerModelEffort({
        flagModel: "fable",
        flagEffort: "max",
        read,
      }),
    ).toEqual({
      model: "fable",
      effort: "max",
      featureFallback: { model: "fable", effort: "max" },
    });
  });

  it("resolves model and effort independently", () => {
    const read = () => ({ efforts: { manager: "low" } });
    expect(resolveManagerModelEffort({ flagModel: "haiku", read })).toEqual({
      model: "haiku",
      effort: "low",
      featureFallback: { model: "haiku" },
    });
  });

  it("ignores invalid config values", () => {
    const read = () => ({
      models: { manager: "gpt" },
      efforts: { manager: "turbo" },
    });
    expect(resolveManagerModelEffort({ read }).model).toBe("opus");
    expect(resolveManagerModelEffort({ read }).effort).toBe("high");
  });
});
