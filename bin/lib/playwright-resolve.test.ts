import { describe, expect, it } from "vitest";
import {
  PLAYWRIGHT_BROWSERS_HINT,
  PLAYWRIGHT_MISSING_HINT,
  resolvePlaywright,
  type PlaywrightDeps,
} from "./playwright-resolve";

const MODULE = "/w/node_modules/playwright/index.js";
const CHROMIUM = "/cache/ms-playwright/chromium-1217/chrome-linux/chrome";

function deps(over: Partial<PlaywrightDeps>): PlaywrightDeps {
  return {
    resolveModule: () => MODULE,
    executablePath: () => CHROMIUM,
    exists: () => true,
    ...over,
  };
}

describe("resolvePlaywright", () => {
  it("is ok when the package resolves and the browser file exists", () => {
    expect(resolvePlaywright("/w", deps({}))).toEqual({
      status: "ok",
      modulePath: MODULE,
      hint: null,
    });
  });

  it("is missing when the package does not resolve, naming the install command", () => {
    const r = resolvePlaywright("/w", deps({ resolveModule: () => null }));
    expect(r.status).toBe("missing");
    expect(r.modulePath).toBeNull();
    expect(r.hint).toBe(PLAYWRIGHT_MISSING_HINT);
    expect(r.hint).toContain(
      "npm i -D @playwright/test && npx playwright install chromium",
    );
  });

  it("is browsers-missing when the package resolves but no browser is downloaded", () => {
    const r = resolvePlaywright("/w", deps({ exists: () => false }));
    expect(r.status).toBe("browsers-missing");
    expect(r.modulePath).toBe(MODULE);
    expect(r.hint).toBe(PLAYWRIGHT_BROWSERS_HINT);
    expect(r.hint).toContain("npx playwright install chromium");
  });

  it("treats an --only-shell install (headless shell only) as present", () => {
    const shell = "/cache/ms-playwright/chromium_headless_shell-1217";
    const r = resolvePlaywright("/w", deps({ exists: (p) => p === shell }));
    expect(r.status).toBe("ok");
  });

  it("is browsers-missing when the executable path cannot be evaluated", () => {
    const r = resolvePlaywright("/w", deps({ executablePath: () => null }));
    expect(r.status).toBe("browsers-missing");
  });

  it("probes through the injected worktree and module path", () => {
    const seen: string[] = [];
    resolvePlaywright(
      "/w",
      deps({
        executablePath: (w, m) => {
          seen.push(w, m);
          return CHROMIUM;
        },
      }),
    );
    expect(seen).toEqual(["/w", MODULE]);
  });
});
