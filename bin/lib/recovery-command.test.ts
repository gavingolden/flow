import { describe, expect, it } from "vitest";
import { recoveryCommandFor } from "./recovery-command";
import { PIPELINE_KINDS } from "./state";

describe("recoveryCommandFor", () => {
  it("names the restart command each supervisor kind actually accepts", () => {
    expect(recoveryCommandFor("checkout", "epic-design")).toBe(
      "flow epic create --resume checkout",
    );
    expect(recoveryCommandFor("checkout", "epic-run")).toBe(
      "flow epic run checkout",
    );
    expect(recoveryCommandFor("csv-export", "feature")).toBe(
      "flow feature resume csv-export",
    );
  });

  it("names the slug-free manager command", () => {
    expect(recoveryCommandFor("manager", "manager")).toBe("flow manage");
  });

  it("is defined for every other PIPELINE_KINDS entry and embeds the slug", () => {
    for (const kind of PIPELINE_KINDS) {
      if (kind === "manager") continue;
      expect(recoveryCommandFor("the-slug", kind)).toContain("the-slug");
    }
  });
});
