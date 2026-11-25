/**
 * Installs, once, the Chromium build the target repo's Playwright version pins
 * when it is missing — so the pre-push browser tests and the UI design review
 * never find a bumped Playwright without its browser. flow ships no Playwright;
 * the repo's own CLI does the download. Never throws: every outcome is a result.
 * node:child_process only — Bun.spawn is undefined under vitest.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";
import {
  defaultPlaywrightDeps,
  type PlaywrightDeps,
} from "./playwright-resolve";
import { recordEvent } from "./telemetry";

export type EnsureOutcome =
  | "not-a-dependency"
  | "package-missing"
  | "disabled"
  | "present"
  | "installed"
  | "failed";

export type EnsureResult = {
  outcome: EnsureOutcome;
  reason: string | null;
  revision: string | null;
  packageVersion: string | null;
  durationMs: number;
};

export type EnsureDeps = PlaywrightDeps & {
  readPackageJson: (worktree: string) => string | null;
  hasRootConfig: (worktree: string) => boolean;
  installEnabled: () => boolean;
  /** `name version` of the resolved Playwright package, or null. */
  readPackageVersion: (modulePath: string) => string | null;
  /** Whether this Playwright's browsers.json lists a chromium-headless-shell build. */
  listsHeadlessShell: (modulePath: string) => boolean;
  runInstall: (
    worktree: string,
    cliPath: string,
    timeoutMs: number,
  ) => Promise<{
    status: number | null;
    timedOut: boolean;
    outputTail?: string;
  }>;
  now: () => number;
  record: (attrs: Record<string, unknown>) => void;
};

export const INSTALL_TIMEOUT_MS = 300_000;
export const MIN_INSTALL_BUDGET_MS = 30_000;
const KILL_GRACE_MS = 2000;
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
const CONFIG_EXTS = ["ts", "js", "mjs", "cjs", "mts", "cts"];

export function readPlaywrightInstallEnabled(
  read: ReadConfigFile = defaultReadConfigFile,
): boolean {
  try {
    const cfg = read() as { playwright?: { installBrowsers?: unknown } } | null;
    return cfg?.playwright?.installBrowsers !== false;
  } catch {
    return true;
  }
}

export function usesPlaywright(
  packageJsonText: string | null,
  hasRootConfig: boolean,
): boolean {
  if (packageJsonText === null) return hasRootConfig;
  try {
    const pkg = JSON.parse(packageJsonText) as Record<string, unknown> | null;
    for (const field of DEP_FIELDS) {
      const deps = pkg?.[field];
      if (deps && typeof deps === "object") {
        const d = deps as Record<string, unknown>;
        if ("@playwright/test" in d || "playwright" in d) return true;
      }
    }
    return hasRootConfig;
  } catch {
    return hasRootConfig;
  }
}

export function pinnedBuildInstalled(
  exe: string,
  exists: (p: string) => boolean,
  requireHeadlessShell = true,
): { installed: boolean; revision: string | null } {
  const parts = exe.split(path.sep);
  const idx = parts.findIndex((s) => /^chromium-\d+$/.test(s));
  if (idx <= 0) return { installed: false, revision: null };
  const revision = parts[idx].slice("chromium-".length);
  const root = parts.slice(0, idx).join(path.sep) || path.sep;
  const marker = (dir: string) =>
    exists(path.join(root, dir, "INSTALLATION_COMPLETE"));
  return {
    installed:
      marker(`chromium-${revision}`) &&
      (!requireHeadlessShell || marker(`chromium_headless_shell-${revision}`)),
    revision,
  };
}

const OUTPUT_TAIL_BYTES = 4000;

export function runInstallDefault(
  worktree: string,
  cliPath: string,
  timeoutMs: number,
): Promise<{ status: number | null; timedOut: boolean; outputTail: string }> {
  return new Promise((resolve) => {
    // Detached: the child leads its own process group so a timeout kills the
    // installer and its download children. Output is piped and only a bounded
    // tail is kept, so the caller can surface it when the install fails.
    const child = spawn("node", [cliPath, "install", "chromium"], {
      cwd: worktree,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputTail = "";
    const collect = (chunk: Buffer) => {
      outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // process group already gone
      }
    };
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const forward = (signal: NodeJS.Signals) => {
      killGroup(signal);
      cleanup();
      process.kill(process.pid, signal);
    };
    for (const s of signals) process.on(s, forward);
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      for (const s of signals) process.off(s, forward);
    };
    child.on("error", () => {
      cleanup();
      resolve({ status: null, timedOut, outputTail });
    });
    // "exit" not "close": a killed installer's orphaned grandchild can hold the
    // pipes open, which would delay "close" past the timeout.
    child.on("exit", (code) => {
      cleanup();
      resolve({ status: code, timedOut, outputTail });
    });
  });
}

function listsHeadlessShellDefault(modulePath: string): boolean {
  let dir = path.dirname(modulePath);
  for (let i = 0; i < 6; i++) {
    for (const rel of [
      "playwright-core/browsers.json",
      "node_modules/playwright-core/browsers.json",
    ]) {
      try {
        const json = JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
        return (json?.browsers ?? []).some(
          (b: { name?: string }) => b?.name === "chromium-headless-shell",
        );
      } catch {
        // not here; keep walking up
      }
    }
    dir = path.dirname(dir);
  }
  return false;
}

function readPackageVersionDefault(modulePath: string): string | null {
  let dir = path.dirname(modulePath);
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (pkg?.name && pkg?.version) return `${pkg.name} ${pkg.version}`;
    } catch {
      // keep walking up
    }
    dir = path.dirname(dir);
  }
  return null;
}

export const defaultEnsureDeps: EnsureDeps = {
  ...defaultPlaywrightDeps,
  readPackageJson: (worktree) => {
    try {
      return readFileSync(path.join(worktree, "package.json"), "utf8");
    } catch {
      return null;
    }
  },
  hasRootConfig: (worktree) =>
    CONFIG_EXTS.some((e) =>
      existsSync(path.join(worktree, `playwright.config.${e}`)),
    ),
  installEnabled: () => readPlaywrightInstallEnabled(),
  readPackageVersion: readPackageVersionDefault,
  listsHeadlessShell: listsHeadlessShellDefault,
  runInstall: runInstallDefault,
  now: () => Date.now(),
  record: (attrs) => recordEvent("playwright.install", attrs),
};

export async function ensurePinnedBrowser(
  worktree: string,
  opts: { deadlineMs?: number } = {},
  deps: EnsureDeps = defaultEnsureDeps,
): Promise<EnsureResult> {
  const start = deps.now();
  let revision: string | null = null;
  let packageVersion: string | null = null;
  const done = (
    outcome: EnsureOutcome,
    reason: string | null = null,
    record = false,
  ): EnsureResult => {
    const result: EnsureResult = {
      outcome,
      reason,
      revision,
      packageVersion,
      durationMs: deps.now() - start,
    };
    if (record) {
      try {
        deps.record({
          outcome,
          reason,
          revision,
          durationMs: result.durationMs,
        });
      } catch {
        // telemetry is best-effort
      }
    }
    return result;
  };
  try {
    if (
      !usesPlaywright(
        deps.readPackageJson(worktree),
        deps.hasRootConfig(worktree),
      )
    ) {
      return done("not-a-dependency");
    }
    const modulePath = deps.resolveModule(worktree);
    if (modulePath === null) return done("package-missing");
    packageVersion = deps.readPackageVersion(modulePath);
    const exe = deps.executablePath(worktree, modulePath);
    if (exe === null) return done("package-missing");
    const needShell = deps.listsHeadlessShell(modulePath);
    const probe = pinnedBuildInstalled(exe, deps.exists, needShell);
    revision = probe.revision;
    if (probe.installed) return done("present");
    if (!deps.installEnabled()) return done("disabled", null, true);

    let timeoutMs = INSTALL_TIMEOUT_MS;
    if (opts.deadlineMs !== undefined) {
      timeoutMs = Math.min(timeoutMs, opts.deadlineMs - deps.now());
      if (timeoutMs < MIN_INSTALL_BUDGET_MS) {
        return done("failed", "no-time-budget", true);
      }
    }
    const cliPath = path.join(path.dirname(modulePath), "cli.js");
    const run = await deps.runInstall(worktree, cliPath, timeoutMs);
    const exe2 = deps.executablePath(worktree, modulePath);
    const after =
      exe2 === null ? null : pinnedBuildInstalled(exe2, deps.exists, needShell);
    if (after?.revision) revision = after.revision;
    if (after?.installed) return done("installed", null, true);
    if (run.outputTail) process.stderr.write(`${run.outputTail.trimEnd()}\n`);
    const reason = run.timedOut
      ? "install-timeout"
      : run.status !== 0
        ? `install-exit-${run.status}`
        : "still-missing-after-install";
    return done("failed", reason, true);
  } catch {
    return done("failed", "ensure-error", true);
  }
}

const REASON_WORDS: Record<string, string> = {
  "install-timeout": "the download timed out",
  "no-time-budget": "there was not enough time left to download it",
  "still-missing-after-install":
    "the installer finished but the build is still missing",
  "ensure-error": "the check itself hit an unexpected error",
};

function reasonWords(reason: string | null): string {
  if (reason === null) return "unknown cause";
  if (REASON_WORDS[reason]) return REASON_WORDS[reason];
  const exit = /^install-exit-(.+)$/.exec(reason);
  return exit ? `the installer exited with status ${exit[1]}` : reason;
}

export function formatEnsureLine(r: EnsureResult): string | null {
  switch (r.outcome) {
    case "installed":
      return `Playwright browser: installed chromium build ${r.revision} for ${r.packageVersion ?? "this repo's Playwright"} (${Math.round(r.durationMs / 1000)} s)`;
    case "failed":
      return `Playwright browser: not installed (${reasonWords(r.reason)}) — pre-push browser tests and the design review may fail until \`npx playwright install chromium\` is run`;
    case "disabled":
      return `Playwright browser: chromium build ${r.revision} is missing and the download is turned off (playwright.installBrowsers is false) — pre-push browser tests and the design review may fail until \`npx playwright install chromium\` is run`;
    default:
      return null;
  }
}
