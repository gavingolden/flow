import { describe, expect, it } from "vitest";

import {
  browserUnavailableBacked,
  classifyOpenBrowserItems,
  driverAttemptFailure,
} from "./browser-items";

const HEAD = "abc123";
const WT = "/wt";
const DRIVER_PATH = "/wt/.flow-tmp/ui-driver-result.json";
const PREFLIGHT_PATH = "/wt/.flow-tmp/ui-preflight.json";

function body(items: string[]): string {
  return `## Test Steps\n\n${items.join("\n")}\n`;
}

const BODY = body([
  "- [x] Run `npm run test -- a.test.ts` — passes",
  '- [ ] Browser: on /a, click Save — expect "Saved"',
  "- [ ] SUBJECTIVE: the page feels calm",
  '- [ ] Browser: on /b, click Go — expect "Gone"',
]);

function files(map: Record<string, unknown>) {
  return {
    readFile: (p: string): string | null =>
      p in map ? JSON.stringify(map[p]) : null,
  };
}

const driver = (over: Record<string, unknown> = {}) => ({
  headSha: HEAD,
  caller: "review-8c",
  ran: true,
  ok: true,
  item_results: [],
  ...over,
});

const statuses = (items: ReturnType<typeof classifyOpenBrowserItems>) =>
  items.map((i) => [i.index, i.status]);

describe("classifyOpenBrowserItems", () => {
  it("is not-attempted when no evidence files exist, with a stable all-items index", () => {
    const items = classifyOpenBrowserItems(BODY, WT, HEAD, files({}));
    expect(statuses(items)).toEqual([
      [2, "not-attempted"],
      [4, "not-attempted"],
    ]);
    expect(items[0].text).toContain("Browser: on /a");
  });

  it("is not-attempted with a null worktree or null headSha", () => {
    const deps = files({ [DRIVER_PATH]: driver({ item_results: [] }) });
    expect(classifyOpenBrowserItems(BODY, null, HEAD, deps)[0].status).toBe(
      "not-attempted",
    );
    expect(classifyOpenBrowserItems(BODY, WT, null, deps)[0].status).toBe(
      "not-attempted",
    );
  });

  it("ignores a driver claim of dependency-unready without a ready:false preflight", () => {
    const deps = files({
      [DRIVER_PATH]: driver({
        ran: false,
        skipped_reason: "dependency-unready",
      }),
    });
    const items = classifyOpenBrowserItems(BODY, WT, HEAD, deps);
    expect(statuses(items)).toEqual([
      [2, "not-attempted"],
      [4, "not-attempted"],
    ]);
    const ready = files({
      [DRIVER_PATH]: driver({
        ran: false,
        skipped_reason: "dependency-unready",
      }),
      [PREFLIGHT_PATH]: { headSha: HEAD, ready: true },
    });
    expect(classifyOpenBrowserItems(BODY, WT, HEAD, ready)[0].status).toBe(
      "not-attempted",
    );
  });

  it("ignores evidence stamped with another head, no head, or caller verify", () => {
    const base = { ran: false, skipped_reason: "mcp-not-available" };
    for (const d of [
      driver({ ...base, headSha: "old" }),
      driver({ ...base, headSha: undefined }),
      driver({ ...base, caller: "verify" }),
      driver({ ...base, caller: undefined }),
    ]) {
      const items = classifyOpenBrowserItems(
        BODY,
        WT,
        HEAD,
        files({ [DRIVER_PATH]: d }),
      );
      expect(items.every((i) => i.status === "not-attempted")).toBe(true);
    }
    const stalePreflight = files({
      [PREFLIGHT_PATH]: { headSha: "old", ready: false },
    });
    expect(
      classifyOpenBrowserItems(BODY, WT, HEAD, stalePreflight)[0].status,
    ).toBe("not-attempted");
  });

  it("classifies login-failed with preflight ready:true as failed (a defect)", () => {
    const deps = files({
      [DRIVER_PATH]: driver({ ran: false, skipped_reason: "login-failed" }),
      [PREFLIGHT_PATH]: { headSha: HEAD, ready: true },
    });
    const items = classifyOpenBrowserItems(BODY, WT, HEAD, deps);
    expect(items.every((i) => i.status === "failed")).toBe(true);
  });

  it.each(["credentials-unavailable", "screenshots-unwritable"])(
    "classifies a %s driver skip as failed so the gate does not offer a pointless retry",
    (skipped_reason) => {
      const deps = files({
        [DRIVER_PATH]: driver({ ran: false, skipped_reason }),
      });
      const items = classifyOpenBrowserItems(BODY, WT, HEAD, deps);
      expect(items.every((i) => i.status === "failed")).toBe(true);
      expect(items[0].reason).toContain(skipped_reason);
    },
  );

  it("classifies login-failed with no preflight as not-attempted", () => {
    const deps = files({
      [DRIVER_PATH]: driver({ ran: false, skipped_reason: "login-failed" }),
    });
    expect(classifyOpenBrowserItems(BODY, WT, HEAD, deps)[0].status).toBe(
      "not-attempted",
    );
  });

  it("does not match an item_results entry that carries no index", () => {
    const deps = files({
      [DRIVER_PATH]: driver({
        item_results: [
          {
            item: 'Browser: on /a, click Save — expect "Saved"',
            kind: "behavior",
            verdict: "pass",
            screenshots: [],
          },
        ],
      }),
    });
    expect(classifyOpenBrowserItems(BODY, WT, HEAD, deps)[0].status).toBe(
      "not-attempted",
    );
  });

  it("maps pass / fail / not-drivable verdicts by index", () => {
    const deps = files({
      [DRIVER_PATH]: driver({
        item_results: [
          {
            index: 2,
            item: "x",
            kind: "behavior",
            verdict: "pass",
            screenshots: [],
          },
          {
            index: 4,
            item: "y",
            kind: "behavior",
            verdict: "fail",
            screenshots: [],
          },
        ],
      }),
    });
    expect(statuses(classifyOpenBrowserItems(BODY, WT, HEAD, deps))).toEqual([
      [2, "passed-unticked"],
      [4, "failed"],
    ]);
    const nd = files({
      [DRIVER_PATH]: driver({
        item_results: [
          {
            index: 2,
            item: "x",
            kind: "behavior",
            verdict: "not-drivable",
            screenshots: [],
          },
        ],
      }),
    });
    expect(classifyOpenBrowserItems(BODY, WT, HEAD, nd)[0].status).toBe(
      "not-drivable",
    );
  });

  it("is env-blocked when a fresh preflight shows ready:false", () => {
    const deps = files({ [PREFLIGHT_PATH]: { headSha: HEAD, ready: false } });
    const items = classifyOpenBrowserItems(BODY, WT, HEAD, deps);
    expect(items.every((i) => i.status === "env-blocked")).toBe(true);
    expect(items[0].reason).toContain("ui-preflight");
  });

  it("is env-blocked for a driver env skip (mcp / profile busy / no artifact)", () => {
    for (const reason of [
      "mcp-not-available",
      "browser-profile-busy",
      "driver-no-artifact",
      "headless-binaries-missing",
    ]) {
      const deps = files({
        [DRIVER_PATH]: driver({ ran: false, skipped_reason: reason }),
      });
      expect(classifyOpenBrowserItems(BODY, WT, HEAD, deps)[0].status).toBe(
        "env-blocked",
      );
    }
  });

  it("keeps the index stable when an earlier item is ticked", () => {
    const ticked = body([
      '- [x] Browser: on /a, click Save — expect "Saved"',
      '- [ ] Browser: on /b, click Go — expect "Gone"',
    ]);
    const deps = files({
      [DRIVER_PATH]: driver({
        item_results: [
          {
            index: 2,
            item: "y",
            kind: "behavior",
            verdict: "fail",
            screenshots: [],
          },
        ],
      }),
    });
    expect(statuses(classifyOpenBrowserItems(ticked, WT, HEAD, deps))).toEqual([
      [2, "failed"],
    ]);
  });

  it("returns nothing when no Browser item is open", () => {
    expect(
      classifyOpenBrowserItems(
        body(["- [x] Browser: on /a, x — expect y"]),
        WT,
        HEAD,
      ),
    ).toEqual([]);
  });
});

describe("browserUnavailableBacked", () => {
  it("is backed by a fresh preflight with ready:false", () => {
    const r = browserUnavailableBacked(
      WT,
      HEAD,
      files({ [PREFLIGHT_PATH]: { headSha: HEAD, ready: false } }),
    );
    expect(r).toMatchObject({ backed: true, source: "preflight" });
  });

  it("is backed by a fresh review-8c driver env skip", () => {
    const r = browserUnavailableBacked(
      WT,
      HEAD,
      files({
        [DRIVER_PATH]: driver({
          ran: false,
          skipped_reason: "mcp-not-available",
        }),
      }),
    );
    expect(r).toMatchObject({ backed: true, source: "driver" });
  });

  it("is backed by a fresh review-8c headless-binaries-missing result, and unbacked when stamped with an older head", () => {
    const skipped = { ran: false, skipped_reason: "headless-binaries-missing" };
    expect(
      browserUnavailableBacked(
        WT,
        HEAD,
        files({ [DRIVER_PATH]: driver(skipped) }),
      ),
    ).toMatchObject({ backed: true, source: "driver" });
    const stale = files({
      [DRIVER_PATH]: driver({ ...skipped, headSha: "old" }),
    });
    expect(browserUnavailableBacked(WT, HEAD, stale).backed).toBe(false);
    expect(classifyOpenBrowserItems(BODY, WT, HEAD, stale)[0].status).toBe(
      "not-attempted",
    );
  });

  it("is unbacked with no files, a ready preflight, a stale stamp, or a verify driver", () => {
    expect(browserUnavailableBacked(WT, HEAD, files({})).backed).toBe(false);
    expect(
      browserUnavailableBacked(
        WT,
        HEAD,
        files({ [PREFLIGHT_PATH]: { headSha: HEAD, ready: true } }),
      ).backed,
    ).toBe(false);
    expect(
      browserUnavailableBacked(
        WT,
        HEAD,
        files({ [PREFLIGHT_PATH]: { headSha: "old", ready: false } }),
      ).backed,
    ).toBe(false);
    expect(
      browserUnavailableBacked(
        WT,
        HEAD,
        files({
          [DRIVER_PATH]: driver({
            caller: "verify",
            ran: false,
            skipped_reason: "mcp-not-available",
          }),
        }),
      ).backed,
    ).toBe(false);
    expect(
      browserUnavailableBacked(
        WT,
        null,
        files({ [PREFLIGHT_PATH]: { headSha: HEAD, ready: false } }),
      ).backed,
    ).toBe(false);
  });
});

describe("data-precondition items", () => {
  it("labels a not-drivable item with a data-precondition reason honestly and keeps it not-drivable", () => {
    const deps = files({
      [DRIVER_PATH]: driver({
        item_results: [
          {
            index: 2,
            item: "x",
            kind: "behavior",
            verdict: "not-drivable",
            reason: "data-precondition: /api/cards answered 429 on /dashboard",
            screenshots: [],
          },
        ],
      }),
    });
    const items = classifyOpenBrowserItems(BODY, WT, HEAD, deps);
    expect(items[0]).toMatchObject({
      index: 2,
      status: "not-drivable",
      reason:
        "data precondition: /api/cards answered 429 on /dashboard — local app data, not a code failure",
    });
  });

  it("keeps the plain label for a not-drivable item with any other reason", () => {
    const deps = files({
      [DRIVER_PATH]: driver({
        item_results: [
          {
            index: 2,
            item: "x",
            kind: "behavior",
            verdict: "not-drivable",
            reason: "exceeded 8 actions",
            screenshots: [],
          },
        ],
      }),
    });
    expect(classifyOpenBrowserItems(BODY, WT, HEAD, deps)[0].reason).toBe(
      "driver verdict: not-drivable",
    );
  });
});

describe("driverAttemptFailure", () => {
  it.each(["app-launch-failed", "login-failed", "dependency-unready"])(
    "returns %s from a fresh review-8c driver artifact",
    (skipped_reason) => {
      const deps = files({
        [DRIVER_PATH]: driver({ ran: false, skipped_reason }),
      });
      expect(driverAttemptFailure(WT, HEAD, deps)).toBe(skipped_reason);
    },
  );

  it("is null for an environment skip, a ran driver, a stale stamp or a verify driver", () => {
    for (const d of [
      driver({ ran: false, skipped_reason: "mcp-not-available" }),
      driver({ ran: false, skipped_reason: "credentials-unavailable" }),
      driver(),
      driver({ ran: false, skipped_reason: "login-failed", headSha: "old" }),
      driver({ ran: false, skipped_reason: "login-failed", caller: "verify" }),
    ]) {
      expect(driverAttemptFailure(WT, HEAD, files({ [DRIVER_PATH]: d }))).toBe(
        null,
      );
    }
    expect(driverAttemptFailure(WT, null, files({}))).toBe(null);
  });
});
