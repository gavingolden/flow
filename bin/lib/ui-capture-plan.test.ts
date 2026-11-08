import { describe, expect, it } from "vitest";

import { planCapture } from "./ui-capture-plan";
import type { UiReviewTarget } from "./ui-review-scope";

const target = (route: string): UiReviewTarget => ({
  route,
  state: null,
  source: "plan",
});
const DIR = ".flow-tmp/ui-evidence/critique";

describe("planCapture viewports", () => {
  it("yields phone, phone-dark, desktop and desktop-dark at 390 and 1280 when the page has a dark scheme", () => {
    const p = planCapture([target("/a")], DIR, true);
    expect(p.viewports.map((v) => v.name)).toEqual([
      "phone",
      "phone-dark",
      "desktop",
      "desktop-dark",
    ]);
    expect(p.viewports.map((v) => v.width)).toEqual([390, 390, 1280, 1280]);
    expect(p.viewports.map((v) => v.colorScheme)).toEqual([
      "light",
      "dark",
      "light",
      "dark",
    ]);
    expect(p.viewports.filter((v) => v.mobile).map((v) => v.name)).toEqual([
      "phone",
      "phone-dark",
    ]);
  });

  it("yields only phone and desktop when there is no dark scheme", () => {
    const p = planCapture([target("/a")], DIR, false);
    expect(p.viewports.map((v) => v.name)).toEqual(["phone", "desktop"]);
    expect(p.viewports.every((v) => v.colorScheme === "light")).toBe(true);
  });

  it("uses a phone viewport of 390x844 and a desktop one of 1280x800", () => {
    const [phone, desktop] = planCapture([target("/a")], DIR, false).viewports;
    expect([phone.width, phone.height]).toEqual([390, 844]);
    expect([desktop.width, desktop.height]).toEqual([1280, 800]);
  });
});

describe("planCapture caps and paths", () => {
  it("caps sections per view at 6 and shots at the 48-entry schema limit", () => {
    const p = planCapture([target("/a")], DIR, true);
    expect(p.maxSectionsPerView).toBe(6);
    expect(p.maxShots).toBe(48);
  });

  it("splits the shot budget across targets so a later one is never starved", () => {
    expect(planCapture([target("/a")], DIR, true).maxShotsPerTarget).toBe(48);
    expect(
      planCapture([target("/a"), target("/b"), target("/c")], DIR, true)
        .maxShotsPerTarget,
    ).toBe(16);
    expect(
      planCapture(["/a", "/b", "/c", "/d"].map(target), DIR, true)
        .maxShotsPerTarget,
    ).toBe(16);
  });

  it("names shots <route-slug>-<n>-<viewport>[-start|-end].png under the evidence dir", () => {
    const { shotPath } = planCapture([target("/a")], DIR, true);
    expect(shotPath("/analysis/AVGO", 2, "phone", "whole")).toBe(
      `${DIR}/analysis-AVGO-2-phone.png`,
    );
    expect(shotPath("/analysis/AVGO", 1, "desktop-dark", "start")).toBe(
      `${DIR}/analysis-AVGO-1-desktop-dark-start.png`,
    );
    expect(shotPath("/analysis/AVGO", 1, "desktop-dark", "end")).toBe(
      `${DIR}/analysis-AVGO-1-desktop-dark-end.png`,
    );
  });

  it("slugs the root route and hashes a fragment so it never shares the bare route's file", () => {
    const { shotPath } = planCapture([target("/")], DIR, false);
    expect(shotPath("/", 1, "phone", "whole")).toBe(`${DIR}/root-1-phone.png`);
    expect(shotPath("/a#x", 1, "phone", "whole")).toMatch(
      /\/a-[0-9a-f]{6}-1-phone\.png$/,
    );
    expect(shotPath("/a#x", 1, "phone", "whole")).not.toBe(
      shotPath("/a", 1, "phone", "whole"),
    );
  });

  it("gives lossy-stem collisions distinct files and keeps clean stems clean", () => {
    const { shotPath } = planCapture([target("/")], DIR, false);
    const shot = (r: string) => shotPath(r, 1, "phone", "whole");
    const otp =
      "/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
    expect(shot(otp)).not.toBe(shot("/"));
    expect(shot(otp)).toMatch(/\/root-[0-9a-f]{6}-1-phone\.png$/);
    expect(shot("/a-b")).not.toBe(shot("/a/b"));
    expect(shot("/a/")).not.toBe(shot("/a"));
    expect(shot("/a?x")).not.toBe(shot("/a?y"));
    expect(shot("/analysis/AVGO")).toBe(`${DIR}/analysis-AVGO-1-phone.png`);
    expect(shot("/")).toBe(`${DIR}/root-1-phone.png`);
  });

  it("gives targets that differ only by query string distinct files", () => {
    const { shotPath } = planCapture([target("/a")], DIR, false);
    const a = shotPath("/a?state=empty", 1, "phone", "whole");
    const b = shotPath("/a?state=loaded", 1, "phone", "whole");
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/a-[0-9a-f]{6}-1-phone\.png$/);
  });
});
