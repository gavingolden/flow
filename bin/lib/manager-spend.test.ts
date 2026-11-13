import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendManagerLog, readManagerLog } from "./manager-log";
import { alertBudgetOnce, budgetReached, dailySpendUsd } from "./manager-spend";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mspend-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// Local noon, so the local date is the same in every timezone.
const NOON = new Date(2026, 10, 12, 12, 0, 0);
const at = (d: Date, h: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0).toISOString();
const spend = (costUsd: number, over: { ts?: string; slug?: string } = {}) =>
  appendManagerLog(
    {
      ts: over.ts ?? NOON.toISOString(),
      kind: "exec-decision",
      repo: "flow",
      ...(over.slug ? { slug: over.slug } : {}),
      exec: { decisionId: "d", reviewKind: "plan", costUsd },
    },
    { home },
  );
const cfg = (dailyBudgetUsd: number) => () => ({ manager: { dailyBudgetUsd } });

describe("dailySpendUsd", () => {
  it("should sum today's exec.costUsd and ignore other days and cost-free lines", () => {
    spend(1.5);
    spend(2);
    spend(9, { ts: new Date(2026, 10, 11, 12).toISOString() });
    appendManagerLog(
      { ts: NOON.toISOString(), kind: "launch", repo: "flow" },
      { home },
    );
    expect(dailySpendUsd(NOON, home)).toBeCloseTo(3.5);
  });

  it("should be zero with no log", () => {
    expect(dailySpendUsd(NOON, home)).toBe(0);
  });

  it("should count by the local date, not the UTC date", () => {
    spend(4, { ts: at(NOON, 0) });
    spend(1, { ts: at(NOON, 23) });
    expect(dailySpendUsd(NOON, home)).toBeCloseTo(5);
  });
});

describe("budgetReached", () => {
  it("should be false under the cap and true at it", () => {
    spend(19.99);
    expect(budgetReached(NOON, { read: cfg(20), home })).toMatchObject({
      reached: false,
      capUsd: 20,
    });
    spend(0.01);
    const r = budgetReached(NOON, { read: cfg(20), home });
    expect(r.reached).toBe(true);
    expect(r.spentUsd).toBeCloseTo(20);
  });

  it("should use the $20 default when nothing is configured", () => {
    spend(20);
    expect(budgetReached(NOON, { read: () => undefined, home }).capUsd).toBe(
      20,
    );
    expect(budgetReached(NOON, { read: () => undefined, home }).reached).toBe(
      true,
    );
  });
});

describe("alertBudgetOnce", () => {
  it("should log and notify once per day, naming the pipelines that spent it", () => {
    spend(12, { slug: "big-one" });
    spend(8, { slug: "small-one" });
    const sent: string[][] = [];
    expect(alertBudgetOnce(NOON, (a) => sent.push(a), home, cfg(20))).toBe(
      true,
    );
    expect(alertBudgetOnce(NOON, (a) => sent.push(a), home, cfg(20))).toBe(
      false,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].slice(0, 4)).toEqual([
      "--status",
      "waiting",
      "--slug",
      "manager",
    ]);
    const reason = sent[0][5];
    expect(reason).toContain("big-one $12.00");
    expect(reason).toContain("small-one $8.00");
    const alerts = readManagerLog({}, home).filter(
      (e) => e.kind === "budget-alert",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe(reason);
  });

  it("should alert again on the next day", () => {
    const sent: string[][] = [];
    alertBudgetOnce(NOON, (a) => sent.push(a), home, cfg(20));
    const tomorrow = new Date(2026, 10, 13, 12);
    expect(alertBudgetOnce(tomorrow, (a) => sent.push(a), home, cfg(20))).toBe(
      true,
    );
    expect(sent).toHaveLength(2);
  });
});
