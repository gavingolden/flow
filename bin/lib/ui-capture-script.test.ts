import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCaptureConfig } from "./ui-capture-config";
import { isDegradedShot } from "./ui-capture-health";
import { buildCaptureScript } from "./ui-capture-script";
import type { Target } from "./ui-capture-args";

const BASE = "http://app.test";
const LOGIN = `${BASE}/login`;
const MARKER = { cookies: [{ name: "session", value: "signed-in" }] };

// A recording stand-in for Playwright: every context and navigation is
// appended to FAKE_LOG so the test can see which session each page was given.
const FAKE_PLAYWRIGHT = String.raw`
const fs = require("fs");
const log = (e) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(e) + "\n");
const MARKER = ${JSON.stringify(MARKER)};
const RESP = process.env.FAKE_RESPONSES
  ? JSON.parse(fs.readFileSync(process.env.FAKE_RESPONSES, "utf8"))
  : {};
let nextCtx = 0;
exports.chromium = {
  launch: async () => ({
    newContext: async (opts = {}) => {
      const id = nextCtx++;
      let current = "about:blank";
      let handler = null;
      let loads = 0;
      const listeners = {};
      const emit = (name, arg) => (listeners[name] || []).forEach((fn) => fn(arg));
      log({
        type: "context", id, storageState: opts.storageState || null,
        serviceWorkers: opts.serviceWorkers || null,
      });
      // Replays the scripted traffic for this route's n-th load of this page.
      const load = async (url) => {
        const evs = (RESP[new URL(url).pathname] || [])[loads++] || [];
        for (const ev of evs) {
          const req = {
            url: () => ev.url,
            method: () => ev.method || "GET",
            resourceType: () => ev.type || "fetch",
            postData: () => ev.postData || null,
            failure: () => (ev.errorText ? { errorText: ev.errorText } : null),
          };
          if (ev.kind === "failed") { emit("requestfailed", req); continue; }
          let served = null;
          if (handler) {
            await handler({
              request: () => req,
              fulfill: async (o) => { served = o; },
              continue: async () => {},
            });
          }
          log({ type: "net", ctx: id, url: ev.url, served: served ? "reuse" : "network" });
          const status = served ? served.status : ev.status;
          const headers = served ? served.headers : ev.headers || {};
          emit("response", {
            request: () => req,
            status: () => status,
            headers: () => headers,
            body: () => (ev.hang ? new Promise(() => {}) : Promise.resolve(Buffer.from("{}"))),
          });
        }
      };
      const page = {
        setDefaultTimeout() {},
        on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
        goto: async (url) => { current = url; log({ type: "goto", ctx: id, url }); await load(url); },
        reload: async () => { log({ type: "reload", ctx: id }); await load(current); },
        waitForTimeout: async (ms) => { log({ type: "wait", ms }); },
        waitForLoadState: async () => {},
        evaluate: async (fn) => {
          const src = typeof fn === "string" ? fn : "";
          if (src.includes('"sel":')) {
            return { found: true, offsetPx: 0, clippedByBottom: process.env.FAKE_CLIPPED === "1" };
          }
          const sections = src.includes("kids.slice") && process.env.FAKE_SECTION === "1"
            ? [{ section: "A", selector: "#a", height: 600 }]
            : [];
          return { hasDarkScheme: false, darkSchemeClass: null, sections, innerHeight: 800 };
        },
        locator: () => ({
          first: () => ({ fill: async () => {}, click: async () => { current = "${BASE}/home"; } }),
          ariaSnapshot: async () => "- document",
        }),
        waitForURL: async () => {},
        url: () => current,
        screenshot: async () => {},
      };
      return {
        newPage: async () => page,
        route: async (pattern, h) => { handler = h; },
        storageState: async () => MARKER,
        close: async () => {},
      };
    },
    close: async () => {},
  }),
};
`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-capture-run-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Event =
  | {
      type: "context";
      id: number;
      storageState: unknown;
      serviceWorkers: string | null;
    }
  | { type: "goto"; ctx: number; url: string }
  | { type: "reload"; ctx: number }
  | { type: "wait"; ms: number }
  | { type: "net"; ctx: number; url: string; served: "reuse" | "network" };

type Traffic = Record<string, Record<string, unknown>[][]>;
type RunOpts = {
  traffic?: Traffic;
  backoff?: { minMs: number; maxMs: number; budgetMs: number };
  bodySettleMs?: number;
  /** Serve one 600px section; its start scroll reports this clippedByBottom. */
  section?: { clippedByBottom: boolean };
};

function runScript(targets: Target[], withLogin: boolean, opts: RunOpts = {}) {
  const fakePath = path.join(dir, "playwright.cjs");
  fs.writeFileSync(fakePath, FAKE_PLAYWRIGHT);
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      ...buildCaptureConfig({
        worktree: dir,
        baseUrl: BASE,
        login: withLogin ? { url: LOGIN } : null,
        targets,
      }),
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
      ...(opts.bodySettleMs ? { bodySettleMs: opts.bodySettleMs } : {}),
    }),
  );
  const trafficPath = path.join(dir, "traffic.json");
  fs.writeFileSync(trafficPath, JSON.stringify(opts.traffic ?? {}));
  const scriptPath = path.join(dir, "capture.cjs");
  fs.writeFileSync(scriptPath, buildCaptureScript(fakePath));
  const logPath = path.join(dir, "events.jsonl");
  const r = spawnSync("node", [scriptPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FLOW_CAPTURE_CONFIG: cfgPath,
      FAKE_LOG: logPath,
      FAKE_RESPONSES: trafficPath,
      ...(opts.section
        ? {
            FAKE_SECTION: "1",
            FAKE_CLIPPED: opts.section.clippedByBottom ? "1" : "0",
          }
        : {}),
      ...(withLogin
        ? { FLOW_CAPTURE_USER: "user", FLOW_CAPTURE_PASS: "pass" }
        : {}),
    },
  });
  const events: Event[] = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
  return { r, out: JSON.parse(r.stdout), events };
}

const contextsFor = (events: Event[], url: string) => {
  const ids = new Set(
    events.flatMap((e) => (e.type === "goto" && e.url === url ? [e.ctx] : [])),
  );
  return events.filter(
    (e): e is Extract<Event, { type: "context" }> =>
      e.type === "context" && ids.has(e.id),
  );
};

describe("generated capture script session choice", () => {
  it("opens a signed-out target with no stored session and an unmarked target with the signed-in one", () => {
    const { out, events } = runScript(
      [
        { route: "/#error=x", state: "signed-out", session: "signed-out" },
        { route: "/app", state: null },
      ],
      true,
    );

    expect(out.ok).toBe(true);
    const signedOut = contextsFor(events, `${BASE}/#error=x`);
    const signedIn = contextsFor(events, `${BASE}/app`);
    expect(signedOut.length).toBeGreaterThan(0);
    expect(signedIn.length).toBeGreaterThan(0);
    expect(signedOut.every((c) => c.storageState === null)).toBe(true);
    expect(signedIn.every((c) => c.storageState !== null)).toBe(true);
    expect(
      events.filter((e) => e.type === "goto" && e.url === LOGIN),
    ).toHaveLength(1);
  });

  it("never visits the login URL when every target is signed-out", () => {
    const { out, events } = runScript(
      [
        { route: "/#error=x", state: "signed-out", session: "signed-out" },
        { route: "/", state: "anonymous", session: "signed-out" },
      ],
      true,
    );

    expect(out.ok).toBe(true);
    expect(events.some((e) => e.type === "goto" && e.url === LOGIN)).toBe(
      false,
    );
    expect(
      events.every((e) => e.type !== "context" || e.storageState === null),
    ).toBe(true);
  });

  it("signs in once for several signed-in targets", () => {
    const { events } = runScript(
      [
        { route: "/a", state: null },
        { route: "/b", state: null },
      ],
      true,
    );
    expect(
      events.filter((e) => e.type === "goto" && e.url === LOGIN),
    ).toHaveLength(1);
  });
});

describe("generated capture script section shots", () => {
  const partsOf = (clippedByBottom: boolean) => {
    const { out } = runScript([t("/a")], false, {
      section: { clippedByBottom },
    });
    expect(out.ok).toBe(true);
    const byViewport = new Map<string, string[]>();
    for (const s of out.shots as { viewport: string; part: string }[]) {
      byViewport.set(s.viewport, [
        ...(byViewport.get(s.viewport) ?? []),
        s.part,
      ]);
    }
    return [...byViewport.values()];
  };

  it("takes start and end shots of a non-tall section still clipped by bottom chrome", () => {
    const parts = partsOf(true);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.join() === "start,end")).toBe(true);
  });

  it("takes one whole shot of a non-tall section the bar does not clip", () => {
    const parts = partsOf(false);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.join() === "whole")).toBe(true);
  });
});

const API = `${BASE}/api/cards`;
const ok = (url = API, extra: Record<string, unknown> = {}) => ({
  kind: "response",
  url,
  status: 200,
  ...extra,
});
const limited = (headers: Record<string, string> = {}, url = API) => ({
  kind: "response",
  url,
  status: 429,
  headers,
});
const FAST = { minMs: 1, maxMs: 5, budgetMs: 600000 };
const t = (route: string): Target => ({ route, state: null });
const shotsOf = (
  out: { shots: { route: string; failedRequests?: { status: number }[] }[] },
  route: string,
) => out.shots.filter((s) => s.route === route);
const ofType = <K extends Event["type"]>(events: Event[], type: K) =>
  events.filter((e): e is Extract<Event, { type: K }> => e.type === type);

describe("generated capture script network handling", () => {
  it("reuses the desktop API responses for the other viewports", () => {
    const other = "http://api.other.test/data";
    const { out, events } = runScript([t("/a")], false, {
      backoff: FAST,
      traffic: {
        "/a": [
          [
            ok(),
            ok(`${BASE}/api/search`, { method: "POST", postData: '{"q":1}' }),
            ok(other),
          ],
        ],
      },
    });

    expect(out.ok).toBe(true);
    const net = ofType(events, "net");
    const served = (url: string, how: string) =>
      net.filter((e) => e.url === url && e.served === how).length;
    expect(served(API, "network")).toBe(1);
    expect(served(API, "reuse")).toBeGreaterThan(0);
    expect(served(`${BASE}/api/search`, "network")).toBe(1);
    expect(served(`${BASE}/api/search`, "reuse")).toBeGreaterThan(0);
    expect(served(other, "reuse")).toBe(0);
    expect(
      ofType(events, "context").every((c) => c.serviceWorkers === "block"),
    ).toBe(true);
  });

  it.each([429, 503])(
    "reloads once after a %i and records nothing when the reload succeeds",
    (status) => {
      const { out, events } = runScript([t("/a")], false, {
        backoff: FAST,
        traffic: { "/a": [[{ ...limited(), status }], [ok()]] },
      });

      expect(out.ok).toBe(true);
      expect(ofType(events, "reload")).toHaveLength(1);
      expect(out.shots.length).toBeGreaterThan(0);
      expect(out.shots.every((s: object) => !("failedRequests" in s))).toBe(
        true,
      );
    },
  );

  it("waits and reloads once per target when a 429 persists, not once per viewport", () => {
    const { out, events } = runScript([t("/a")], false, {
      backoff: FAST,
      traffic: { "/a": [[limited()], [limited()], [limited()], [limited()]] },
    });

    expect(ofType(events, "reload")).toHaveLength(1);
    expect(ofType(events, "wait")).toHaveLength(1);
    expect(shotsOf(out, "/a").length).toBeGreaterThan(1);
    const live = ofType(events, "net").filter(
      (e) => e.url === API && e.served === "network",
    );
    expect(live).toHaveLength(2);
    expect(
      shotsOf(out, "/a").every((x) => x.failedRequests?.[0].status === 429),
    ).toBe(true);
  });

  it("keeps a 429 when a POST with a different body to the same URL succeeds", () => {
    const post = (body: string, status: number) => ({
      kind: "response",
      url: `${BASE}/graphql`,
      method: "POST",
      postData: body,
      status,
    });
    const { out } = runScript([t("/a")], false, {
      backoff: { minMs: 1, maxMs: 5, budgetMs: 0 },
      traffic: { "/a": [[post("a", 429), post("b", 200)]] },
    });

    expect(shotsOf(out, "/a")[0].failedRequests).toEqual([
      { url: "app.test/graphql", status: 429, count: 1 },
    ]);
  });

  it("counts repeated requests to one URL and keeps a 429 within the failure cap", () => {
    const storm = Array.from({ length: 5 }, () => limited());
    const boom = Array.from({ length: 25 }, (_, i) => ({
      kind: "response",
      url: `${BASE}/api/e${i}`,
      status: 500,
    }));
    const { out } = runScript([t("/a"), t("/b")], false, {
      backoff: { minMs: 1, maxMs: 5, budgetMs: 0 },
      traffic: {
        "/a": [storm],
        "/b": [[...boom, limited({}, `${BASE}/api/limited`)]],
      },
    });

    const stormFail = out.shots.find(
      (s: { route: string }) => s.route === "/a",
    ).failedRequests;
    expect(stormFail).toEqual([
      { url: "app.test/api/cards", status: 429, count: 5 },
    ]);
    expect(isDegradedShot({ failedRequests: stormFail })).toBe(false);
    const capped = shotsOf(out, "/b")[0].failedRequests;
    expect(capped).toHaveLength(20);
    expect(capped?.some((f: { status: number }) => f.status === 429)).toBe(
      true,
    );
  });

  it("does not wait on a response body that never finishes", () => {
    const { out, events } = runScript([t("/a")], false, {
      backoff: FAST,
      bodySettleMs: 50,
      traffic: { "/a": [[ok(API, { hang: true })]] },
    });

    expect(out.ok).toBe(true);
    expect(out.shots.length).toBeGreaterThan(0);
    const net = ofType(events, "net").filter((e) => e.url === API);
    expect(net.every((e) => e.served === "network")).toBe(true);
  });

  it("spends the wait budget across targets and stops reloading once it is used", () => {
    const { out, events } = runScript([t("/a"), t("/b")], false, {
      backoff: { minMs: 2, maxMs: 2, budgetMs: 2 },
      traffic: { "/a": [[limited()], [ok()]], "/b": [[limited()], [ok()]] },
    });

    expect(ofType(events, "reload")).toHaveLength(1);
    expect(shotsOf(out, "/b")[0].failedRequests?.[0].status).toBe(429);
  });

  it("honours Retry-After seconds within the floor and cap", () => {
    const traffic: Traffic = {};
    const routes = ["/a", "/b", "/c", "/d"];
    const headers = [
      { "retry-after": "1" },
      { "retry-after": "0" },
      { "retry-after": "999" },
      { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    ];
    routes.forEach((r, i) => {
      traffic[r] = [[limited(headers[i])], [ok()]];
    });

    const { events } = runScript(routes.map(t), false, {
      backoff: { minMs: 100, maxMs: 3000, budgetMs: 600000 },
      traffic,
    });

    expect(ofType(events, "wait").map((w) => w.ms)).toEqual([
      1000, 100, 3000, 100,
    ]);
  });

  it("records a persisting 429 on every shot of that page", () => {
    const { out } = runScript([t("/a"), t("/clean")], false, {
      backoff: FAST,
      traffic: { "/a": [[limited()], [limited()], [limited()], [limited()]] },
    });

    const limitedShots = shotsOf(out, "/a");
    expect(limitedShots.length).toBeGreaterThan(1);
    for (const s of limitedShots) {
      expect(s.failedRequests).toEqual([
        { url: "app.test/api/cards", status: 429, count: 1 },
      ]);
    }
    expect(
      shotsOf(out, "/clean").every((s: object) => !("failedRequests" in s)),
    ).toBe(true);
  });

  it("clears a failure the app's own retry recovered", () => {
    const { out, events } = runScript([t("/a")], false, {
      backoff: FAST,
      traffic: { "/a": [[limited(), ok()]] },
    });

    expect(ofType(events, "reload")).toHaveLength(0);
    expect(out.shots.every((s: object) => !("failedRequests" in s))).toBe(true);
  });

  it("ignores aborted requests and non-API resource types", () => {
    const { out, events } = runScript([t("/a")], false, {
      backoff: FAST,
      traffic: {
        "/a": [
          [
            { kind: "failed", url: API, errorText: "net::ERR_ABORTED" },
            { ...limited({}, `${BASE}/logo.png`), type: "image" },
            { ...limited({}, `${BASE}/app.css`), type: "stylesheet" },
            { ...limited({}, `${BASE}/app.js`), type: "script" },
          ],
        ],
      },
    });

    expect(ofType(events, "reload")).toHaveLength(0);
    expect(out.shots.every((s: object) => !("failedRequests" in s))).toBe(true);
  });

  it("records a network failure and a 500 without reloading", () => {
    const { out, events } = runScript([t("/a")], false, {
      backoff: FAST,
      traffic: {
        "/a": [
          [
            {
              kind: "failed",
              url: `${BASE}/api/down`,
              errorText: "net::ERR_FAILED",
            },
            { kind: "response", url: `${BASE}/api/boom`, status: 500 },
          ],
        ],
      },
    });

    expect(ofType(events, "reload")).toHaveLength(0);
    const urls = out.shots[0].failedRequests.map(
      (f: { url: string; status: number }) => [f.url, f.status],
    );
    expect(urls).toEqual(
      expect.arrayContaining([
        ["app.test/api/down", 0],
        ["app.test/api/boom", 500],
      ]),
    );
  });

  it("caps failedRequests at 20 entries and 300-char urls", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      kind: "response",
      url: `${BASE}/${i}${"x".repeat(400)}`,
      status: 500,
    }));
    const { out } = runScript([t("/a")], false, {
      backoff: FAST,
      traffic: { "/a": [many] },
    });

    const fr = out.shots[0].failedRequests;
    expect(fr).toHaveLength(20);
    expect(fr.every((f: { url: string }) => f.url.length <= 300)).toBe(true);
  });

  it("stops waiting once the budget is spent", () => {
    const { out, events } = runScript([t("/a"), t("/b")], false, {
      backoff: { minMs: 1, maxMs: 5, budgetMs: 0 },
      traffic: { "/a": [[limited()], [ok()]], "/b": [[limited()], [ok()]] },
    });

    expect(ofType(events, "wait")).toHaveLength(0);
    expect(ofType(events, "reload")).toHaveLength(0);
    expect(shotsOf(out, "/b")[0].failedRequests?.[0].status).toBe(429);
  });
});
