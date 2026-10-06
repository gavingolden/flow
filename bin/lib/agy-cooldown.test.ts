import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGY_COOLDOWN_MINUTES,
  COOLDOWN_ARMING_CLASSES,
  armCooldown,
  readCooldown,
  shouldArmCooldown,
} from "./agy-cooldown";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cooldown-"));
  file = path.join(dir, "nested", "agy-cooldown.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("agy cooldown marker", () => {
  it("is not live when no marker exists", () => {
    expect(readCooldown(new Date(), file)).toEqual({ live: false });
  });

  it("is live within 60 minutes of arming and expired after", () => {
    const t0 = new Date("2026-10-06T12:00:00Z");
    armCooldown(["quota-exhausted"], t0, file);
    const inside = new Date(t0.getTime() + (AGY_COOLDOWN_MINUTES - 1) * 60_000);
    const outside = new Date(
      t0.getTime() + (AGY_COOLDOWN_MINUTES + 1) * 60_000,
    );
    const live = readCooldown(inside, file);
    expect(live.live).toBe(true);
    expect(live.until).toBe("2026-10-06T13:00:00.000Z");
    expect(readCooldown(outside, file)).toEqual({ live: false });
  });

  it.each(["", "{not json", "[]", '{"until":"nope"}', '{"until":5}'])(
    "reads a torn or garbage marker %j as not live",
    (contents) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
      expect(readCooldown(new Date(), file)).toEqual({ live: false });
    },
  );

  it("writes atomically: no temp file is left beside the marker", () => {
    armCooldown(["timeout"], new Date(), file);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["agy-cooldown.json"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).classes).toEqual([
      "timeout",
    ]);
  });

  it("re-arming replaces the previous marker", () => {
    armCooldown(["timeout"], new Date("2026-10-06T12:00:00Z"), file);
    armCooldown(["unknown"], new Date("2026-10-06T14:00:00Z"), file);
    expect(readCooldown(new Date("2026-10-06T14:30:00Z"), file).live).toBe(
      true,
    );
  });
});

describe("shouldArmCooldown", () => {
  it("arms only when every class spent quota and there is at least one", () => {
    expect(shouldArmCooldown([])).toBe(false);
    expect(shouldArmCooldown(["quota-exhausted", "timeout"])).toBe(true);
    for (const c of COOLDOWN_ARMING_CLASSES) {
      expect(shouldArmCooldown([c])).toBe(true);
    }
  });

  it.each([
    "model-unavailable",
    "auth",
    "spawn-failed",
    "canceled",
    "environment",
  ])("never arms on the environment class %s", (c) => {
    expect(shouldArmCooldown([c])).toBe(false);
    expect(shouldArmCooldown(["quota-exhausted", c])).toBe(false);
  });
});
