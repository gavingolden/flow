import { describe, expect, it } from "vitest";
import { readConfigModels } from "./read-config-models";

describe("readConfigModels", () => {
  it("returns an empty reviewLenses grain for a missing config", () => {
    const config = readConfigModels(() => undefined);
    expect(config.reviewLenses).toEqual({});
    expect(config.fixApplier).toBeUndefined();
  });

  it("folds flat grains and valid nested lens aliases, dropping invalid ones", () => {
    const config = readConfigModels(() => ({
      models: {
        fixApplier: "haiku",
        review: "nope",
        reviewLenses: { security: "opus", product: "gpt4" },
      },
    }));
    expect(config.fixApplier).toBe("haiku");
    expect(config.review).toBeUndefined();
    expect(config.reviewLenses).toEqual({ security: "opus" });
  });

  it("reads the config file once across every grain", () => {
    let reads = 0;
    readConfigModels(() => {
      reads++;
      return { models: { planning: "sonnet" } };
    });
    expect(reads).toBe(1);
  });
});
