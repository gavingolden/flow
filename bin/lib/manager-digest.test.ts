import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestSince, markSeen, readDigestSeen } from "./manager-digest";
import { appendManagerLog, type ManagerLogEntry } from "./manager-log";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mdigest-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const add = (
  e: Partial<ManagerLogEntry> & Pick<ManagerLogEntry, "ts" | "kind">,
) => appendManagerLog({ repo: "flow", ...e }, { home });

describe("digestSince", () => {
  it("counts in-scope and slug-less decisions after the cut and ignores out-of-scope ones", () => {
    add({
      ts: "2026-11-12T00:00:00.000Z",
      kind: "manager-decision",
      slug: "in",
    });
    add({
      ts: "2026-11-12T00:01:00.000Z",
      kind: "manager-decision",
      slug: "out",
    });
    add({ ts: "2026-11-12T00:02:00.000Z", kind: "budget-alert" });
    add({ ts: "2026-11-12T00:03:00.000Z", kind: "launch", slug: "in" });
    const r = digestSince(null, { home, inScopeSlug: (s) => s === "in" });
    expect(r.count).toBe(2);
    expect(r.byKind).toEqual({ "manager-decision": 1, "budget-alert": 1 });
    const later = digestSince("2026-11-12T00:00:30.000Z", {
      home,
      inScopeSlug: (s) => s === "in",
    });
    expect(later.count).toBe(1);
  });

  it("markSeen records the last look", () => {
    expect(readDigestSeen(home)).toBeNull();
    markSeen(new Date("2026-11-12T00:00:00.000Z"), home);
    expect(readDigestSeen(home)).toBe("2026-11-12T00:00:00.000Z");
  });
});
