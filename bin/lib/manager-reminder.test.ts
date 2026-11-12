import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManagerLog } from "./manager-log";
import { reminderDue, sendDailyReminder } from "./manager-reminder";
import type { PipelineState } from "./state";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const waiting = (slug: string, at: string, phase = "gated"): PipelineState => ({
  slug,
  phase,
  repo: "/r/flow",
  updatedAt: at,
  phaseLog: [{ phase, at }],
});
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mrem-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("reminderDue", () => {
  it("counts only owner-needed items past 24h and names the oldest", () => {
    const r = reminderDue(
      [
        waiting("old", "2026-11-09T12:00:00.000Z"),
        waiting("older", "2026-11-05T12:00:00.000Z", "plan-pending-review"),
        waiting("fresh", "2026-11-12T10:00:00.000Z"),
        waiting("busy", "2026-11-01T00:00:00.000Z", "implementing"),
        waiting("done", "2026-11-01T00:00:00.000Z", "merged"),
      ],
      NOW,
    );
    expect(r.due).toBe(true);
    expect(r.count).toBe(2);
    expect(r.oldest?.slug).toBe("older");
  });

  it("is not due when nothing waited more than a day", () => {
    expect(
      reminderDue([waiting("fresh", "2026-11-12T10:00:00.000Z")], NOW).due,
    ).toBe(false);
  });
});

describe("sendDailyReminder", () => {
  it("fires once per local day and logs the reminder", () => {
    const calls: string[][] = [];
    const states = [waiting("old", "2026-11-09T12:00:00.000Z")];
    expect(sendDailyReminder(NOW, states, (a) => calls.push(a), home)).toBe(
      true,
    );
    expect(sendDailyReminder(NOW, states, (a) => calls.push(a), home)).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].join(" ")).toContain("old");
    expect(
      readManagerLog({}, home).filter((e) => e.kind === "reminder"),
    ).toHaveLength(1);
  });

  it("says waited 7+ days on you for an item that old", () => {
    const calls: string[][] = [];
    sendDailyReminder(
      NOW,
      [waiting("ancient", "2026-11-01T12:00:00.000Z")],
      (a) => calls.push(a),
      home,
    );
    expect(calls[0].join(" ")).toContain("waited 7+ days on you");
  });

  it("sends nothing when no item is due", () => {
    const calls: string[][] = [];
    expect(sendDailyReminder(NOW, [], (a) => calls.push(a), home)).toBe(false);
    expect(calls).toEqual([]);
  });
});
