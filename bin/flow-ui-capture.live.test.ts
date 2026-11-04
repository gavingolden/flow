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
    server = spawn(
      "node",
      [
        "-e",
        `const s=require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end(${JSON.stringify(PAGE)})});s.listen(0,()=>console.log(s.address().port))`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
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
  }, 120_000);
});
