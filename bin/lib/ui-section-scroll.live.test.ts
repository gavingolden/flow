/**
 * Live check of the section scroll function against a real Chromium. Skipped
 * unless `FLOW_UI_CAPTURE_PLAYWRIGHT_DIR` names a directory whose
 * `node_modules` holds Playwright with its Chromium downloaded.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sectionsScript } from "./ui-heuristics";
import type { SectionScrollResult } from "./ui-section-scroll";

const PW_DIR = process.env.FLOW_UI_CAPTURE_PLAYWRIGHT_DIR;

type Page = {
  setContent: (html: string) => Promise<void>;
  evaluate: <T>(src: string) => Promise<T>;
};
type Browser = {
  newContext: (o: object) => Promise<{ newPage: () => Promise<Page> }>;
  close: () => Promise<void>;
};

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};

function fixture(o: {
  heights?: number[];
  bodyPad?: number;
  header?: boolean;
  hideBarOnDesktop?: boolean;
  reset?: boolean;
}): string {
  const heights = o.heights ?? [1400, 1400, 1400];
  const pad = o.bodyPad ?? 65;
  const sections = heights
    .map(
      (h, i) =>
        `<section id="s${i}" style="height:${h}px;margin:0;position:relative"><h2>S${i}</h2>` +
        `<div class="last-row" style="position:absolute;left:0;right:0;bottom:0;height:40px">end</div></section>`,
    )
    .join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;${o.reset ? "" : `padding-bottom:${pad}px`}}
${o.reset ? `html,body{height:100%}body{overflow-x:hidden}main{padding-bottom:${pad}px;display:block}` : ""}
#bar{position:fixed;bottom:0;left:0;width:100%;height:57px;background:#333}
#hdr{position:sticky;top:0;height:56px;background:#ccc}
${o.hideBarOnDesktop ? "@media (min-width:1000px){#bar{display:none}}" : ""}
</style></head><body>${o.header ? '<div id="hdr">header</div>' : ""}<main>${sections}</main><div id="bar">bar</div></body></html>`;
}

describe.skipIf(!PW_DIR)("section scroll against a real Chromium", () => {
  let browser: Browser;

  beforeAll(async () => {
    const realHome = os.userInfo().homedir;
    const cache = [
      path.join(realHome, "Library", "Caches", "ms-playwright"),
      path.join(realHome, ".cache", "ms-playwright"),
    ].find((p) => fs.existsSync(p));
    if (cache) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    const req = createRequire(path.join(PW_DIR as string, "package.json"));
    const { chromium } = req("playwright");
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  async function open(html: string, ctx: object = PHONE): Promise<Page> {
    const page = await (await browser.newContext(ctx)).newPage();
    await page.setContent(html);
    await page.evaluate(`(${sectionsScript()})()`);
    return page;
  }

  const scroll = (page: Page, i: number, part: "start" | "end") =>
    page.evaluate<SectionScrollResult>(
      `window.__flowScrollSection(${JSON.stringify({ sel: `#s${i}`, part })})`,
    );

  const rects = (page: Page, i: number) =>
    page.evaluate<{
      sTop: number;
      sBottom: number;
      lastBottom: number;
      barTop: number;
      hdrBottom: number;
    }>(
      `(() => {
        const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
        const s = r("#s${i}"), l = document.querySelector("#s${i} .last-row").getBoundingClientRect();
        const b = r("#bar"), h = r("#hdr");
        return { sTop: s.top, sBottom: s.bottom, lastBottom: l.bottom, barTop: b ? b.top : 0, hdrBottom: h ? h.bottom : 0 };
      })()`,
    );

  it("clears the bar for the last section's end", async () => {
    const page = await open(fixture({}));
    await scroll(page, 2, "end");
    const r = await rects(page, 2);
    expect(r.lastBottom).toBeLessThanOrEqual(r.barTop + 1);
  });

  it("puts a middle section's end right above the bar", async () => {
    const page = await open(fixture({}));
    await scroll(page, 1, "end");
    const r = await rects(page, 1);
    expect(Math.abs(r.sBottom - r.barTop)).toBeLessThanOrEqual(1);
  });

  it("stops at the document end when there is no room to nudge", async () => {
    const page = await open(fixture({ bodyPad: 20 }));
    await scroll(page, 2, "end");
    const s = await page.evaluate<{ y: number; max: number }>(
      "({ y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) })",
    );
    expect(s.y).toBe(s.max);
    const r = await rects(page, 2);
    expect(r.lastBottom).toBeGreaterThan(r.barTop);
  });

  it("keeps a start shot below a pinned sticky header", async () => {
    const page = await open(fixture({ header: true }));
    await scroll(page, 1, "start");
    const r = await rects(page, 1);
    expect(r.sTop).toBeGreaterThanOrEqual(r.hdrBottom - 1);
  });

  it("does not move when the bar is hidden at desktop width", async () => {
    const page = await open(fixture({ hideBarOnDesktop: true }), {
      viewport: { width: 1280, height: 800 },
    });
    const res = await scroll(page, 1, "end");
    expect(res.offsetPx).toBe(0);
  });

  it("control: a plain scrollIntoView end leaves the last row under the bar", async () => {
    const page = await open(fixture({}));
    await page.evaluate(
      'document.querySelector("#s2").scrollIntoView({ block: "end", behavior: "instant" })',
    );
    const r = await rects(page, 2);
    expect(r.lastBottom).toBeGreaterThan(r.barTop);
  });

  it("flags a 900px section as clipped at its start and clears the bar at its end", async () => {
    const page = await open(fixture({ heights: [1400, 900, 1400] }));
    const start = await scroll(page, 1, "start");
    expect(start.clippedByBottom).toBe(true);
    await scroll(page, 1, "end");
    const r = await rects(page, 1);
    expect(r.sBottom).toBeLessThanOrEqual(r.barTop + 1);
  });

  it("still clears the bar under an html/body height reset", async () => {
    const page = await open(fixture({ reset: true }));
    await scroll(page, 2, "end");
    const r = await rects(page, 2);
    expect(r.lastBottom).toBeLessThanOrEqual(r.barTop + 1);
  });
});
