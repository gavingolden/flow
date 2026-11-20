/**
 * Live check of the generated capture script against a real Playwright. Skipped
 * unless `FLOW_UI_CAPTURE_PLAYWRIGHT_DIR` names a directory whose
 * `node_modules` holds Playwright with its Chromium downloaded (for example a
 * consumer repo checkout): flow itself ships no Playwright.
 */
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultDeps, run } from "./flow-ui-capture";
import { validateUiDriverResult } from "./lib/ui-driver-schema";

const PW_DIR = process.env.FLOW_UI_CAPTURE_PLAYWRIGHT_DIR;

const PAGE = `<!doctype html><html><head><title>t</title>
<style>:root{color-scheme:light dark}body{margin:0;font:16px sans-serif}
section{height:900px;padding:24px}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style></head>
<body><main>
<section id="intro"><h2>Intro</h2><p>First section.</p></section>
<section id="details"><h2>Details</h2><p>Second section.</p></section>
</main></body></html>`;

// `/rl-once` and `/rl-always` call `/api/once` and `/api/always`: the first
// answers 429 once then 200, the second always 429. `/__hits` reports how
// often each API path was hit.
const PAGE_API = PAGE.replace(
  "</body>",
  '<script>fetch(location.pathname.replace("/rl-","/api/")).then((r)=>r.text())</script></body>',
);
const SERVER = `
const hits = {};
const page = ${JSON.stringify(PAGE)};
const pageApi = ${JSON.stringify(PAGE_API)};
const s = require("http").createServer((q, r) => {
  const p = new URL(q.url, "http://x").pathname;
  if (p === "/__hits") return r.end(JSON.stringify(hits));
  if (p.startsWith("/api/")) {
    const n = (hits[p] = (hits[p] || 0) + 1);
    if (p === "/api/always" || (p === "/api/once" && n === 1)) {
      r.statusCode = 429;
      r.setHeader("retry-after", "1");
      return r.end("slow down");
    }
    r.setHeader("content-type", "application/json");
    return r.end("{}");
  }
  r.setHeader("content-type", "text/html");
  r.end(p === "/" ? page : pageApi);
});
s.listen(0, () => console.log(s.address().port));
`;

describe.skipIf(!PW_DIR)("flow-ui-capture against a real Playwright", () => {
  let worktree = "";
  // A separate process: run() blocks this one on spawnSync, which would starve
  // an in-process server.
  let server: ChildProcess | undefined;
  let port = 0;

  beforeAll(async () => {
    // The test harness points HOME at a scratch dir, hiding the real browser
    // cache; pin Playwright to the invoking user's cache.
    const realHome = os.userInfo().homedir;
    const cache = [
      path.join(realHome, "Library", "Caches", "ms-playwright"),
      path.join(realHome, ".cache", "ms-playwright"),
    ].find((p) => fs.existsSync(p));
    if (cache) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-capture-live-"));
    fs.symlinkSync(
      path.join(PW_DIR as string, "node_modules"),
      path.join(worktree, "node_modules"),
    );
    server = spawn("node", ["-e", SERVER], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    port = await new Promise<number>((resolve) =>
      server?.stdout?.once("data", (d) => resolve(Number(String(d).trim()))),
    );
  });

  afterAll(() => {
    server?.kill();
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("writes a schema-valid artifact whose every listed shot exists on disk", () => {
    const targets = path.join(worktree, "targets.json");
    const out = path.join(worktree, ".flow-tmp", "capture-driver.json");
    fs.writeFileSync(targets, JSON.stringify([{ route: "/", state: null }]));
    const lines: string[] = [];
    const deps = {
      ...defaultDeps(),
      writeOut: (l: string) => void lines.push(l),
    };
    const code = run(
      [
        "--worktree",
        worktree,
        "--targets",
        targets,
        "--base-url",
        `http://localhost:${port}`,
        "--out",
        out,
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toContain('"ran":true');
    const artifact = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(validateUiDriverResult(artifact).ok).toBe(true);
    expect(artifact.section_shots.length).toBeGreaterThan(0);
    for (const s of artifact.section_shots) {
      expect(fs.existsSync(s.path)).toBe(true);
    }
    const viewports = new Set(
      artifact.section_shots.map((s: { viewport: string }) => s.viewport),
    );
    expect(viewports.has("phone")).toBe(true);
    expect(viewports.has("desktop")).toBe(true);
    expect(viewports.has("phone-dark")).toBe(true);
    expect(viewports.has("desktop-dark")).toBe(true);
    expect(artifact.route_snapshots.length).toBeGreaterThan(0);
  }, 120_000);

  function capture(route: string) {
    const targets = path.join(worktree, "targets.json");
    const out = path.join(worktree, ".flow-tmp", "capture-driver.json");
    fs.writeFileSync(targets, JSON.stringify([{ route, state: null }]));
    const lines: string[] = [];
    const code = run(
      [
        "--worktree",
        worktree,
        "--targets",
        targets,
        "--base-url",
        `http://localhost:${port}`,
        "--out",
        out,
      ],
      { ...defaultDeps(), writeOut: (l: string) => void lines.push(l) },
    );
    expect(code).toBe(0);
    const shots: { failedRequests?: { status: number }[] }[] = JSON.parse(
      fs.readFileSync(out, "utf8"),
    ).section_shots;
    return shots;
  }
  const hitsOf = async (): Promise<Record<string, number>> =>
    (await fetch(`http://localhost:${port}/__hits`)).json();

  it("recovers a page whose first API call was rate-limited", async () => {
    const shots = capture("/rl-once");

    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((s) => s.failedRequests === undefined)).toBe(true);
    expect((await hitsOf())["/api/once"]).toBeLessThanOrEqual(2);
  }, 170_000);

  it("labels every shot of a page whose API stays rate-limited", async () => {
    const started = Date.now();
    const shots = capture("/rl-always");

    expect(Date.now() - started).toBeLessThan(150_000);
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) {
      expect(s.failedRequests?.some((f) => f.status === 429)).toBe(true);
    }
  }, 170_000);
});
