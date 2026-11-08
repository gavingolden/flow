import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCaptureConfig } from "./ui-capture-config";
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
let nextCtx = 0;
exports.chromium = {
  launch: async () => ({
    newContext: async (opts = {}) => {
      const id = nextCtx++;
      let current = "about:blank";
      log({ type: "context", id, storageState: opts.storageState || null });
      const page = {
        setDefaultTimeout() {},
        goto: async (url) => { current = url; log({ type: "goto", ctx: id, url }); },
        waitForLoadState: async () => {},
        evaluate: async () => ({
          hasDarkScheme: false, darkSchemeClass: null, sections: [], innerHeight: 800,
        }),
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
  | { type: "context"; id: number; storageState: unknown }
  | { type: "goto"; ctx: number; url: string };

function runScript(targets: Target[], withLogin: boolean) {
  const fakePath = path.join(dir, "playwright.cjs");
  fs.writeFileSync(fakePath, FAKE_PLAYWRIGHT);
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      buildCaptureConfig({
        worktree: dir,
        baseUrl: BASE,
        login: withLogin ? { url: LOGIN } : null,
        targets,
      }),
    ),
  );
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
