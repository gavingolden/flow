import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGY_COOLDOWN_MAX_MS,
  AGY_COOLDOWN_MINUTES,
  COOLDOWN_ARMING_CLASSES,
  armCooldown,
  quotaResetMs,
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

  it("never arms on a refusal alone or beside a non-quota class", () => {
    expect(shouldArmCooldown(["content-filtered"])).toBe(false);
    expect(shouldArmCooldown(["content-filtered", "content-filtered"])).toBe(
      false,
    );
    expect(shouldArmCooldown(["content-filtered", "timeout"])).toBe(false);
    expect(shouldArmCooldown(["content-filtered", "unknown"])).toBe(false);
    expect(shouldArmCooldown(["content-filtered", "environment"])).toBe(false);
  });

  it("arms when a refusal sits next to a real quota or rate-limit failure", () => {
    expect(shouldArmCooldown(["content-filtered", "quota-exhausted"])).toBe(
      true,
    );
    expect(shouldArmCooldown(["content-filtered", "rate-limited"])).toBe(true);
  });

  it("keeps content-filtered out of the arming classes", () => {
    expect(COOLDOWN_ARMING_CLASSES).not.toContain("content-filtered");
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

describe("quota reset parsing", () => {
  it("reads agy's 'Resets in' duration and keeps the longest", () => {
    expect(
      quotaResetMs([
        "Individual quota reached. Resets in 4h44m12s.",
        undefined,
        "Resets in 30m",
      ]),
    ).toBe((4 * 3600 + 44 * 60 + 12) * 1000);
  });

  it("returns null when no text names a reset", () => {
    expect(quotaResetMs(["quota reached", undefined])).toBeNull();
  });

  it("holds the marker until the named reset instead of the default window", () => {
    const now = new Date("2026-10-06T08:00:00Z");
    armCooldown(["quota-exhausted"], now, file, 5 * 3_600_000);
    expect(readCooldown(new Date("2026-10-06T12:59:00Z"), file).live).toBe(
      true,
    );
    expect(readCooldown(new Date("2026-10-06T13:01:00Z"), file).live).toBe(
      false,
    );
  });

  it("clamps an absurd reset to the ceiling", () => {
    expect(quotaResetMs(["Resets in 99999h"])).toBe(AGY_COOLDOWN_MAX_MS);
    expect(quotaResetMs(["Resets in 4h44m12s"])).toBe(
      (4 * 3600 + 44 * 60 + 12) * 1000,
    );
  });
});

describe("armCooldown never shortens a hold", () => {
  it("keeps a later existing hold when a shorter arm follows", () => {
    const t0 = new Date("2026-10-06T08:00:00Z");
    armCooldown(["quota-exhausted"], t0, file, 5 * 3_600_000);
    armCooldown(["timeout"], new Date("2026-10-06T08:10:00Z"), file);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(rec.until).toBe("2026-10-06T13:00:00.000Z");
    expect(rec.classes).toEqual(["quota-exhausted"]);
  });

  it("extends a shorter existing hold", () => {
    const t0 = new Date("2026-10-06T08:00:00Z");
    armCooldown(["timeout"], t0, file);
    armCooldown(["quota-exhausted"], t0, file, 5 * 3_600_000);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(rec.until).toBe("2026-10-06T13:00:00.000Z");
    expect(rec.classes).toEqual(["quota-exhausted"]);
  });
});
