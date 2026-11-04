/**
 * The Node script `flow-ui-capture` runs against the TARGET repo's Playwright.
 * Generated text rather than a bundled module: Playwright resolves from the
 * target repo, not from flow. It reads its plan from a JSON file named by
 * `FLOW_CAPTURE_CONFIG` and takes credentials only from the child's
 * environment (`FLOW_CAPTURE_USER` / `FLOW_CAPTURE_PASS`); it never prints
 * them and never screenshots the login page.
 */
import { heuristicsProbeScript, sectionsScript } from "./ui-heuristics";
import type { CaptureViewport } from "./ui-capture-plan";

export type CaptureConfig = {
  baseUrl: string;
  login: { url: string } | null;
  targets: { route: string; snapshotPath: string }[];
  viewportsLight: CaptureViewport[];
  viewportsDark: CaptureViewport[];
  maxSectionsPerView: number;
  maxShotsPerTarget: number;
  /** `route|n|viewport|part` -> absolute screenshot path. */
  names: Record<string, string>;
};

export type CaptureOutput =
  | {
      ok: true;
      shots: {
        route: string;
        section: string;
        viewport: CaptureViewport["name"];
        part: "whole" | "start" | "end";
        path: string;
      }[];
      snapshots: { route: string; path: string }[];
      omittedSections: number;
    }
  | { ok: false; error: string; detail?: string };

export const nameKey = (
  route: string,
  n: number,
  vp: string,
  part: string,
): string => [route, n, vp, part].join("|");

const BODY = String.raw`
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(process.env.FLOW_CAPTURE_CONFIG, "utf8"));
const USER = process.env.FLOW_CAPTURE_USER || "";
const PASS = process.env.FLOW_CAPTURE_PASS || "";
const PROBE = "(" + PROBE_SRC + ")()";
const SECTIONS = "(" + SECTIONS_SRC + ")()";
const out = { shots: [], snapshots: [], omittedSections: 0 };

const redact = (s) => {
  let t = String(s);
  for (const secret of [USER, PASS]) if (secret) t = t.split(secret).join("***");
  return t.slice(0, 300);
};
const settle = (page) => page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
const applyDark = (cls) => {
  const el = document.documentElement;
  if (cls.startsWith(".")) { el.classList.add(cls.slice(1)); return; }
  const m = /\[([\w-]+)=["']?([\w-]+)["']?\]/.exec(cls);
  if (m) el.setAttribute(m[1], m[2]);
};
const scrollTo = (a) => {
  const el = document.querySelector(a.sel);
  if (el) el.scrollIntoView({ block: a.block, behavior: "instant" });
};

async function login(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(cfg.login.url, { waitUntil: "load" });
  await page.locator("input[type=email], input[autocomplete=username]").first().fill(USER);
  await page.locator("input[type=password]").first().fill(PASS);
  await page.locator("button[type=submit]").first().click();
  const loginPath = new URL(cfg.login.url).pathname;
  await page.waitForURL((u) => u.pathname !== loginPath, { timeout: 10000 }).catch(() => {});
  if (new URL(page.url()).pathname === loginPath) {
    await ctx.close();
    const e = new Error("still on the login page");
    e.code = "login-failed";
    throw e;
  }
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function open(browser, storageState, vp, scheme, url) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    deviceScaleFactor: 1,
    colorScheme: scheme,
    ...(storageState ? { storageState } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url, { waitUntil: "load" });
  await settle(page);
  return { ctx, page };
}

async function captureTarget(browser, storageState, t) {
  const url = new URL(t.route, cfg.baseUrl).href;
  const desktop = cfg.viewportsDark.find((v) => v.name === "desktop");
  const first = await open(browser, storageState, desktop, "light", url);
  const probe = await first.page.evaluate(PROBE);
  try {
    const snap = await first.page.locator("body").ariaSnapshot();
    fs.mkdirSync(path.dirname(t.snapshotPath), { recursive: true });
    fs.writeFileSync(t.snapshotPath, String(snap).slice(0, 30000));
    out.snapshots.push({ route: t.route, path: t.snapshotPath });
  } catch (e) {
    // ariaSnapshot needs a recent Playwright; the screenshots still go ahead.
  }
  await first.ctx.close();

  let budget = cfg.maxShotsPerTarget;
  for (const vp of probe.hasDarkScheme ? cfg.viewportsDark : cfg.viewportsLight) {
    const { ctx, page } = await open(browser, storageState, vp, vp.colorScheme, url);
    if (vp.colorScheme === "dark" && probe.darkSchemeClass) {
      await page.evaluate(applyDark, probe.darkSchemeClass);
    }
    const found = await page.evaluate(SECTIONS);
    const sections = found.sections.slice(0, cfg.maxSectionsPerView);
    out.omittedSections += found.sections.length - sections.length;
    // A page with no detectable sections is still judged, from its top.
    const plan = sections.length > 0 ? sections : [{ section: "Page top", selector: null, height: 0 }];
    for (let i = 0; i < plan.length; i++) {
      const s = plan[i];
      const parts = s.height > 1.5 * found.innerHeight ? [["start", "start"], ["end", "end"]] : [["whole", "start"]];
      for (const [part, block] of parts) {
        if (budget <= 0) { out.omittedSections++; break; }
        if (s.selector) await page.evaluate(scrollTo, { sel: s.selector, block });
        const file = cfg.names[[t.route, i + 1, vp.name, part].join("|")];
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: false });
        budget--;
        out.shots.push({ route: t.route, section: s.section, viewport: vp.name, part, path: file });
      }
    }
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const storageState = cfg.login ? await login(browser) : null;
    for (const t of cfg.targets) await captureTarget(browser, storageState, t);
  } finally {
    await browser.close();
  }
})().then(
  () => process.stdout.write(JSON.stringify(Object.assign({ ok: true }, out)) + "\n"),
  (e) => process.stdout.write(JSON.stringify({ ok: false, error: (e && e.code) || "capture-failed", detail: redact(e && e.message ? e.message : e) }) + "\n"),
);
`;

/**
 * `modulePath` is the absolute path of the repo's resolved Playwright: a bare
 * `require("playwright")` from a script elsewhere cannot see the worktree's
 * `node_modules`. Playwright is not supported under Bun, so the caller runs
 * this with `node`.
 */
export function buildCaptureScript(modulePath: string): string {
  return [
    '"use strict";',
    `const { chromium } = require(${JSON.stringify(modulePath)});`,
    `const PROBE_SRC = ${JSON.stringify(heuristicsProbeScript())};`,
    `const SECTIONS_SRC = ${JSON.stringify(sectionsScript())};`,
    BODY,
  ].join("\n");
}
