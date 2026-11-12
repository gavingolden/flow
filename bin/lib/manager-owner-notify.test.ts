import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendManagerLog } from "./manager-log";
import { notifyOwnerNeeded } from "./manager-owner-notify";
import { ownerNeededKey } from "./manager-wait";
import type { PipelineState } from "./state";

const NOW = new Date("2026-11-12T01:00:00.000Z");
const st = (phase: string): PipelineState => ({
  slug: "a",
  phase,
  repo: "/r/flow",
  updatedAt: NOW.toISOString(),
  phaseLog: [{ phase, at: NOW.toISOString() }],
});
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mnotify-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ev = (to: string) => [
  { kind: "transition" as const, slug: "a", repo: "flow", to },
];

describe("notifyOwnerNeeded", () => {
  it("notifies once for a plan-pending-review and not again", () => {
    const calls: string[][] = [];
    const run = () =>
      notifyOwnerNeeded(
        ev("plan-pending-review"),
        [st("plan-pending-review")],
        (a) => calls.push(a),
        NOW,
        home,
      );
    expect(run()).toBe(1);
    expect(run()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("a");
  });

  it("stays silent for phases the pipeline announces itself", () => {
    const calls: string[][] = [];
    expect(
      notifyOwnerNeeded(
        ev("gated"),
        [st("gated")],
        (a) => calls.push(a),
        NOW,
        home,
      ),
    ).toBe(0);
    expect(calls).toEqual([]);
  });

  it("defers to a key the epic sequencer already logged", () => {
    const s = st("plan-pending-review");
    appendManagerLog(
      {
        ts: NOW.toISOString(),
        kind: "owner-needed",
        repo: "flow",
        key: ownerNeededKey(s),
      },
      { home },
    );
    const calls: string[][] = [];
    expect(
      notifyOwnerNeeded(
        ev("plan-pending-review"),
        [s],
        (a) => calls.push(a),
        NOW,
        home,
      ),
    ).toBe(0);
  });
});
