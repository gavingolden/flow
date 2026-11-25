import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensurePinnedBrowser,
  formatEnsureLine,
  INSTALL_TIMEOUT_MS,
  defaultEnsureDeps,
  pinnedBuildInstalled,
  runInstallDefault,
  readPlaywrightInstallEnabled,
  usesPlaywright,
  type EnsureDeps,
} from "./playwright-browsers";

const ROOT = "/cache/ms-playwright";
const EXE = `${ROOT}/chromium-1255/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
const FULL = `${ROOT}/chromium-1255/INSTALLATION_COMPLETE`;
const SHELL = `${ROOT}/chromium_headless_shell-1255/INSTALLATION_COMPLETE`;
const PKG = JSON.stringify({
  devDependencies: { "@playwright/test": "^1.65" },
});

function makeDeps(
  over: Partial<EnsureDeps> & {
    present?: Set<string>;
    installAdds?: string[];
  } = {},
) {
  const present = over.present ?? new Set<string>();
  const installAdds = over.installAdds ?? [FULL, SHELL];
  const runInstall = vi.fn(async (_wt: string, _cli: string, _ms: number) => {
    for (const p of installAdds) present.add(p);
    return { status: 0, timedOut: false };
  });
  const record = vi.fn();
  let t = 1000;
  const deps: EnsureDeps = {
    resolveModule: vi.fn(() => "/wt/node_modules/@playwright/test/index.js"),
    executablePath: vi.fn(() => EXE),
    exists: (p) => present.has(p),
    readPackageJson: () => PKG,
    hasRootConfig: () => false,
    installEnabled: () => true,
    readPackageVersion: () => "@playwright/test 1.65.1",
    listsHeadlessShell: () => true,
    runInstall,
    now: () => (t += 1000),
    record,
    ...over,
  };
  return {
    deps,
    runInstall: deps.runInstall as typeof runInstall,
    record,
    present,
  };
}

describe("ensurePinnedBrowser", () => {
  it("installs once after a version bump and reports the new build", async () => {
    const { deps, runInstall, record } = makeDeps();
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("installed");
    expect(r.revision).toBe("1255");
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(runInstall).toHaveBeenCalledWith(
      "/wt",
      "/wt/node_modules/@playwright/test/cli.js",
      INSTALL_TIMEOUT_MS,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(formatEnsureLine(r)).toMatch(
      /^Playwright browser: installed chromium build 1255 for @playwright\/test 1\.65\.1 \(\d+ s\)$/,
    );
  });

  it("does nothing when both markers are present", async () => {
    const { deps, runInstall, record } = makeDeps({
      present: new Set([FULL, SHELL]),
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("present");
    expect(runInstall).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(formatEnsureLine(r)).toBeNull();
  });

  it("installs when only the full build is present (no headless shell)", async () => {
    const { deps, runInstall } = makeDeps({ present: new Set([FULL]) });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("installed");
  });

  it("installs when the markers are missing after an interrupted extract", async () => {
    const { deps, runInstall } = makeDeps({
      present: new Set([EXE, `${ROOT}/chromium_headless_shell-1255/x`]),
    });
    await ensurePinnedBrowser("/wt", {}, deps);
    expect(runInstall).toHaveBeenCalledTimes(1);
  });

  it("skips a transitive-only dependency without probing", async () => {
    const { deps, runInstall } = makeDeps({
      readPackageJson: () => JSON.stringify({ dependencies: { x: "1" } }),
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("not-a-dependency");
    expect(deps.resolveModule).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("probes when only a root playwright config exists", async () => {
    const { deps } = makeDeps({
      readPackageJson: () => "{}",
      hasRootConfig: () => true,
      present: new Set([FULL, SHELL]),
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("present");
    expect(deps.resolveModule).toHaveBeenCalledTimes(1);
  });

  it("is silent when the package is unresolvable", async () => {
    const { deps, record, runInstall } = makeDeps({
      resolveModule: vi.fn(() => null),
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("package-missing");
    expect(formatEnsureLine(r)).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("is silent when the executable path cannot be read", async () => {
    const { deps } = makeDeps({ executablePath: vi.fn(() => null) });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("package-missing");
  });

  it("opted out + present stays quiet", async () => {
    const { deps, record } = makeDeps({
      installEnabled: () => false,
      present: new Set([FULL, SHELL]),
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("present");
    expect(formatEnsureLine(r)).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it("opted out + missing is disabled with one record", async () => {
    const { deps, runInstall, record } = makeDeps({
      installEnabled: () => false,
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("disabled");
    expect(r.revision).toBe("1255");
    expect(runInstall).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(formatEnsureLine(r)).toContain("download is turned off");
    expect(formatEnsureLine(r)).toContain("npx playwright install chromium");
  });

  it("refuses to start an install with under 30 s left", async () => {
    const { deps, runInstall, record } = makeDeps({ now: () => 1000 });
    const r = await ensurePinnedBrowser(
      "/wt",
      { deadlineMs: 1000 + 29_000 },
      deps,
    );
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("no-time-budget");
    expect(runInstall).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("caps the install timeout to the remaining deadline", async () => {
    const { deps, runInstall } = makeDeps({ now: () => 1000 });
    await ensurePinnedBrowser("/wt", { deadlineMs: 1000 + 100_000 }, deps);
    expect(runInstall.mock.calls[0][2]).toBe(100_000);
  });

  it("re-probes after a timeout and reports installed when the build landed", async () => {
    const { deps, present } = makeDeps();
    deps.runInstall = vi.fn(async () => {
      present.add(FULL);
      present.add(SHELL);
      return { status: null, timedOut: true };
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("installed");
  });

  it.each([
    [{ status: 3, timedOut: false }, "install-exit-3", "exited with status 3"],
    [{ status: null, timedOut: true }, "install-timeout", "timed out"],
    [
      { status: 0, timedOut: false },
      "still-missing-after-install",
      "still missing",
    ],
  ])("fails with %j as %s", async (run, reason, words) => {
    const { deps, record } = makeDeps();
    deps.runInstall = vi.fn(async () => run);
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe(reason);
    expect(record).toHaveBeenCalledTimes(1);
    const line = formatEnsureLine(r) ?? "";
    expect(line).toContain(words);
    expect(line).toContain("may fail");
    expect(line).not.toContain(reason);
  });

  it("never throws", async () => {
    const { deps } = makeDeps({
      resolveModule: () => {
        throw new Error("boom");
      },
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("ensure-error");
  });
});

describe("readPlaywrightInstallEnabled", () => {
  it.each([undefined, null, "garbage", {}, { playwright: null }])(
    "is true for %j",
    (cfg) => {
      expect(readPlaywrightInstallEnabled(() => cfg)).toBe(true);
    },
  );
  it("is true for strict true and wrong types", () => {
    expect(
      readPlaywrightInstallEnabled(() => ({
        playwright: { installBrowsers: true },
      })),
    ).toBe(true);
    expect(
      readPlaywrightInstallEnabled(() => ({
        playwright: { installBrowsers: "false" },
      })),
    ).toBe(true);
  });
  it("is true when the read throws", () => {
    expect(
      readPlaywrightInstallEnabled(() => {
        throw new Error("x");
      }),
    ).toBe(true);
  });
  it("is false only for strict false", () => {
    expect(
      readPlaywrightInstallEnabled(() => ({
        playwright: { installBrowsers: false },
      })),
    ).toBe(false);
  });
});

describe("usesPlaywright", () => {
  it.each(["dependencies", "devDependencies", "optionalDependencies"])(
    "detects @playwright/test and playwright in %s",
    (field) => {
      expect(
        usesPlaywright(
          JSON.stringify({ [field]: { "@playwright/test": "1" } }),
          false,
        ),
      ).toBe(true);
      expect(
        usesPlaywright(JSON.stringify({ [field]: { playwright: "1" } }), false),
      ).toBe(true);
    },
  );
  it("is false for transitive-only without a root config", () => {
    expect(
      usesPlaywright(JSON.stringify({ dependencies: { other: "1" } }), false),
    ).toBe(false);
  });
  it("is true for a root config alone", () => {
    expect(usesPlaywright("{}", true)).toBe(true);
    expect(usesPlaywright(null, true)).toBe(true);
  });
  it("falls back to the root config on malformed JSON", () => {
    expect(usesPlaywright("{nope", false)).toBe(false);
    expect(usesPlaywright("{nope", true)).toBe(true);
  });
});

describe("headless shell requirement", () => {
  it("is present with only the full build when no headless shell is pinned", async () => {
    const { deps, runInstall } = makeDeps({
      present: new Set([FULL]),
      listsHeadlessShell: () => false,
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("present");
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("installs the full build when no headless shell is pinned and it is missing", async () => {
    const { deps } = makeDeps({
      listsHeadlessShell: () => false,
      installAdds: [FULL],
    });
    const r = await ensurePinnedBrowser("/wt", {}, deps);
    expect(r.outcome).toBe("installed");
  });

  it("pinnedBuildInstalled ignores the shell marker when not required", () => {
    const has = (p: string) => p === FULL;
    expect(pinnedBuildInstalled(EXE, has, false).installed).toBe(true);
    expect(pinnedBuildInstalled(EXE, has, true).installed).toBe(false);
  });
});

describe("pinnedBuildInstalled", () => {
  it("returns no revision for a path without a chromium-<rev> segment", () => {
    expect(pinnedBuildInstalled("/x/y", () => true)).toEqual({
      installed: false,
      revision: null,
    });
  });
});

describe("runInstallDefault timeout", () => {
  it("kills the installer and its child processes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pw-timeout-"));
    try {
      const pidFile = path.join(dir, "grandchild.pid");
      const cli = path.join(dir, "cli.js");
      writeFileSync(
        cli,
        `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const g = spawn("sleep", ["60"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
console.log("downloading");
setInterval(() => {}, 1000);
`,
      );
      const run = await runInstallDefault(dir, cli, 1000);
      expect(run.timedOut).toBe(true);
      expect(run.outputTail).toContain("downloading");
      const pid = Number(readFileSync(pidFile, "utf8"));
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listsHeadlessShell default (hoisted layout)", () => {
  const withTree = (browsers: unknown[], fn: (mod: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pw-hoist-"));
    try {
      const core = path.join(dir, "node_modules", "playwright-core");
      const mod = path.join(dir, "node_modules", "@playwright", "test");
      mkdirSync(core, { recursive: true });
      mkdirSync(mod, { recursive: true });
      writeFileSync(
        path.join(core, "package.json"),
        JSON.stringify({ name: "playwright-core", version: "1.60.0" }),
      );
      writeFileSync(
        path.join(core, "browsers.json"),
        JSON.stringify({ browsers }),
      );
      writeFileSync(path.join(mod, "index.js"), "");
      fn(path.join(mod, "index.js"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("finds a hoisted playwright-core that lists the shell", () => {
    withTree([{ name: "chromium-headless-shell" }], (mod) =>
      expect(defaultEnsureDeps.listsHeadlessShell(mod)).toBe(true),
    );
  });

  it("is false when the pinned list has no shell", () => {
    withTree([{ name: "chromium" }], (mod) =>
      expect(defaultEnsureDeps.listsHeadlessShell(mod)).toBe(false),
    );
  });
});
