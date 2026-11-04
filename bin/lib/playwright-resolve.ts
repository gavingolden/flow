/**
 * Resolves the TARGET repo's own Playwright for the deterministic UI capture.
 * flow ships no Playwright (no browser download per flow install); the capture
 * uses whatever the worktree's `node_modules` provides, and a missing package
 * or undownloaded browser is a named, loud status — never a silent skip.
 *
 * The install hints are text for the flow user only. No code or doc may tell
 * the agent to run them: "never install browser binaries".
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

export type PlaywrightStatus = {
  status: "ok" | "missing" | "browsers-missing";
  modulePath: string | null;
  hint: string | null;
};

export const PLAYWRIGHT_MISSING_HINT =
  "UI review screenshots need Playwright in this repo — run `npm i -D @playwright/test && npx playwright install chromium`";
export const PLAYWRIGHT_BROWSERS_HINT =
  "UI review screenshots need Playwright's browser in this repo — run `npx playwright install chromium`";

export type PlaywrightDeps = {
  /** Absolute path of the Playwright module as the worktree sees it, or null. */
  resolveModule: (worktree: string) => string | null;
  /** `chromium.executablePath()` evaluated by node in the worktree, or null. */
  executablePath: (worktree: string, modulePath: string) => string | null;
  exists: (p: string) => boolean;
};

const MODULE_NAMES = ["playwright", "@playwright/test"];

// Playwright is not supported under Bun, so the browser probe runs through
// node from the worktree — the same runtime the capture script uses.
const EXECUTABLE_SCRIPT =
  "process.stdout.write(require(process.argv[1]).chromium.executablePath())";

export const defaultPlaywrightDeps: PlaywrightDeps = {
  resolveModule: (worktree) => {
    const req = createRequire(path.join(worktree, "package.json"));
    for (const name of MODULE_NAMES) {
      try {
        return req.resolve(name);
      } catch {
        // not installed under this name
      }
    }
    return null;
  },
  executablePath: (worktree, modulePath) => {
    const r = spawnSync("node", ["-e", EXECUTABLE_SCRIPT, modulePath], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 15_000,
    });
    const out = (r.stdout ?? "").trim();
    return r.status === 0 && out.length > 0 ? out : null;
  },
  exists: (p) => existsSync(p),
};

// A `--only-shell` install has only `chromium_headless_shell-<rev>`, which is
// enough for a headless capture, so either build counts as a present browser.
function browserPresent(exe: string, exists: (p: string) => boolean): boolean {
  if (exists(exe)) return true;
  const parts = exe.split(path.sep);
  const idx = parts.findIndex((s) => /^chromium-\d+$/.test(s));
  if (idx <= 0) return false;
  const rev = parts[idx].slice("chromium-".length);
  const root = parts.slice(0, idx).join(path.sep) || path.sep;
  return exists(path.join(root, `chromium_headless_shell-${rev}`));
}

export function resolvePlaywright(
  worktree: string,
  deps: PlaywrightDeps = defaultPlaywrightDeps,
): PlaywrightStatus {
  const modulePath = deps.resolveModule(worktree);
  if (modulePath === null) {
    return {
      status: "missing",
      modulePath: null,
      hint: PLAYWRIGHT_MISSING_HINT,
    };
  }
  const exe = deps.executablePath(worktree, modulePath);
  if (exe === null || !browserPresent(exe, deps.exists)) {
    return {
      status: "browsers-missing",
      modulePath,
      hint: PLAYWRIGHT_BROWSERS_HINT,
    };
  }
  return { status: "ok", modulePath, hint: null };
}
