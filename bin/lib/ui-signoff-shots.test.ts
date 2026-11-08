import { describe, expect, it } from "vitest";

import { itemCapturesToShots } from "./ui-signoff-shots";
import type { UiDriverItemResult } from "./ui-driver-schema";

const item = (over: Partial<UiDriverItemResult>): UiDriverItemResult => ({
  item: "SUBJECTIVE: the menu feels calm",
  kind: "capture",
  verdict: "captured",
  screenshots: [],
  ...over,
});

describe("itemCapturesToShots", () => {
  it("maps captured items to section shots with the item text as the section", () => {
    const shots = itemCapturesToShots([
      item({
        screenshots: [
          ".flow-tmp/ui-evidence/menu-390.png",
          ".flow-tmp/ui-evidence/menu-1280.png",
        ],
      }),
    ]);
    expect(shots).toEqual([
      {
        route: "(sign-off)",
        section: "SUBJECTIVE: the menu feels calm",
        viewport: "phone",
        part: "whole",
        path: ".flow-tmp/ui-evidence/menu-390.png",
      },
      {
        route: "(sign-off)",
        section: "SUBJECTIVE: the menu feels calm",
        viewport: "desktop",
        part: "whole",
        path: ".flow-tmp/ui-evidence/menu-1280.png",
      },
    ]);
  });

  it("labels a phone-named shot phone but keeps a desktop shot of a phone feature desktop", () => {
    const viewports = itemCapturesToShots([
      item({
        screenshots: [
          ".flow-tmp/ui-evidence/item12-placeholder-phone.png",
          ".flow-tmp/ui-evidence/verify-phone-desktop.png",
        ],
      }),
    ]).map((s) => s.viewport);
    expect(viewports).toEqual(["phone", "desktop"]);
  });

  it("takes the route from the matching fix_context entry", () => {
    const shots = itemCapturesToShots(
      [item({ screenshots: [".flow-tmp/ui-evidence/a-1280.png"] })],
      [{ item: "SUBJECTIVE: the menu feels calm", route: "/analysis/AVGO" }],
    );
    expect(shots[0].route).toBe("/analysis/AVGO");
  });

  it("drops screenshot paths outside the evidence directory", () => {
    const shots = itemCapturesToShots([
      item({
        screenshots: [
          "/Users/u/.ssh/id_ed25519",
          ".flow-tmp/ui-evidence/../x.png",
        ],
      }),
    ]);
    expect(shots).toEqual([]);
  });

  it("skips items that were not captured or are not capture items", () => {
    expect(
      itemCapturesToShots([
        item({ verdict: "not-captured", screenshots: ["x-390.png"] }),
        item({ kind: "appearance", verdict: "pass", screenshots: ["y.png"] }),
      ]),
    ).toEqual([]);
  });
});
