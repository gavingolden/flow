#!/usr/bin/env bun
/**
 * Deterministic section capture for the UI design review: photographs the
 * review targets through the TARGET repo's own Playwright, outside any LLM
 * turn budget, and writes a driver-schema artifact the critic reads unchanged.
 *
 *   flow-ui-capture --worktree <w> --targets <targets.json> --base-url <url>
 *                   [--manifest <p>] --out <capture-driver.json>
 *   flow-ui-capture --probe --worktree <w>
 *
 * Every outcome prints one JSON object on stdout and exits 0; a capture that
 * cannot run is `{"ran":false,"skipReason":…}`, never a thrown error. Bad
 * arguments exit 2. `--probe` prints the Playwright status and captures
 * nothing. The caller launches the app (`flow-spawn --from-envelope`); this
 * helper only takes `--base-url`, which must be a loopback address.
 *
 * Threat model: this runs repo code and, when the manifest declares a login,
 * types the seeded test account into the login form. It applies the same
 * guards as `flow-ui-login test-account` (committed manifest, localhost-only
 * targets) BEFORE any credential is resolved, passes values only through the
 * child's environment, and never prints, persists or photographs them.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import {
  resolvePlaywright,
  type PlaywrightStatus,
} from "./lib/playwright-resolve";
import {
  manifestLogin,
  parseCaptureArgs,
  readTargets,
  USAGE,
} from "./lib/ui-capture-args";
import { buildCaptureConfig } from "./lib/ui-capture-config";
import {
  buildCaptureScript,
  type CaptureConfig,
  type CaptureOutput,
} from "./lib/ui-capture-script";
import { validateUiDriverResult } from "./lib/ui-driver-schema";
import {
  isLocalBaseUrl,
  isLocalLoginUrl,
  MANIFEST_REL,
  resolveTestAccount,
  type TestAccountResult,
} from "./lib/ui-test-account";

export type Deps = {
  resolvePlaywright: (worktree: string) => PlaywrightStatus;
  runNode: (
    script: string,
    env: Record<string, string>,
    cwd: string,
  ) => { exitCode: number; stdout: string };
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string) => void;
  mkdirp: (dir: string) => void;
  mkdtemp: (parent: string) => string;
  removeDir: (dir: string) => void;
  gitHead: (worktree: string) => string | null;
  resolveTestAccount: (o: {
    manifest: string;
    worktree: string;
  }) => TestAccountResult;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
};

export function run(argv: string[], deps: Deps): number {
  const flags = parseCaptureArgs(argv);
  if (typeof flags === "string") {
    deps.writeErr(`flow-ui-capture: ${flags}\n${USAGE}\n`);
    return 2;
  }
  const w = flags.worktree;
  const skip = (skipReason: string, extra: Record<string, unknown> = {}) => {
    deps.writeOut(JSON.stringify({ ran: false, skipReason, ...extra }));
    return 0;
  };
  const pw = deps.resolvePlaywright(w);
  if (flags.probe) {
    deps.writeOut(JSON.stringify(pw));
    return 0;
  }
  if (pw.status !== "ok") {
    return skip(
      pw.status === "missing"
        ? "playwright-unavailable"
        : "playwright-browsers-missing",
      { hint: pw.hint },
    );
  }
  const baseUrl = flags["base-url"];
  if (!isLocalBaseUrl(baseUrl)) return skip("non-local-base-url");
  const targets = readTargets(deps.readFile(flags.targets));
  if (targets === null || targets.length === 0) return skip("no-targets");

  const manifest = flags.manifest ?? path.join(w, MANIFEST_REL);
  const loginUrl = manifestLogin(deps.readFile(manifest));
  let login: CaptureConfig["login"] = null;
  let env: Record<string, string> = {};
  if (loginUrl !== null) {
    if (!isLocalLoginUrl(baseUrl, loginUrl)) return skip("non-local-base-url");
    const acct = deps.resolveTestAccount({ manifest, worktree: w });
    if (!acct.ok) {
      return skip(
        acct.reason === "credentials-missing"
          ? "credentials-unavailable"
          : acct.reason,
      );
    }
    const port = new URL(baseUrl).port;
    login = {
      url: new URL(
        loginUrl.replace(/\{\{PORT(_[A-Z0-9_]+)?\}\}/g, port),
        baseUrl,
      ).href,
    };
    env = {
      FLOW_CAPTURE_USER: acct.values.user,
      FLOW_CAPTURE_PASS: acct.values.pass,
    };
  }

  const config = buildCaptureConfig({ worktree: w, baseUrl, login, targets });

  const parent = path.join(w, ".flow-tmp", "ui-capture");
  deps.mkdirp(parent);
  const tmp = deps.mkdtemp(parent);
  let out: CaptureOutput;
  try {
    const script = path.join(tmp, "capture.cjs");
    const cfgPath = path.join(tmp, "config.json");
    deps.writeFile(script, buildCaptureScript(pw.modulePath as string));
    deps.writeFile(cfgPath, JSON.stringify(config));
    const r = deps.runNode(script, { ...env, FLOW_CAPTURE_CONFIG: cfgPath }, w);
    try {
      out = JSON.parse(
        r.stdout.trim().split("\n").pop() ?? "",
      ) as CaptureOutput;
    } catch {
      out = {
        ok: false,
        error: "capture-failed",
        detail: `node exited ${r.exitCode}`,
      };
    }
  } finally {
    deps.removeDir(tmp);
  }
  if (!out.ok) {
    const code =
      out.error === "login-failed" ? "login-failed" : "capture-failed";
    return skip(code, { detail: out.detail ?? out.error });
  }

  const artifact = {
    headSha: deps.gitHead(w) ?? undefined,
    caller: "verify",
    ran: true,
    ok: true,
    captures_path: "",
    ui_screenshots: [],
    fix_context: [],
    rejected_alternatives: [],
    summary: `Deterministic Playwright capture of ${targets.length} target(s): ${out.shots.length} section screenshot(s).`,
    section_shots: out.shots,
    route_snapshots: out.snapshots,
  };
  const valid = validateUiDriverResult(artifact);
  if (!valid.ok)
    return skip("capture-failed", { detail: valid.errors.join("; ") });
  deps.mkdirp(path.dirname(flags.out));
  deps.writeFile(flags.out, JSON.stringify(artifact, null, 2) + "\n");
  deps.writeOut(
    JSON.stringify({
      ran: true,
      out: flags.out,
      shots: out.shots.length,
      omittedSections: out.omittedSections,
    }),
  );
  return 0;
}

function sh(argv: string[], cwd: string): string | null {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

export function defaultDeps(): Deps {
  return {
    resolvePlaywright: (w) => resolvePlaywright(w),
    // Playwright is not supported under Bun, so the script runs through node.
    runNode: (script, env, cwd) => {
      const r = spawnSync("node", [script], {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 300_000,
      });
      return { exitCode: r.status ?? -1, stdout: r.stdout ?? "" };
    },
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeFile: (p, c) => writeFileSync(p, c),
    mkdirp: (d) => void mkdirSync(d, { recursive: true }),
    mkdtemp: (parent) => mkdtempSync(path.join(parent, "run-")),
    removeDir: (d) => void rmSync(d, { recursive: true, force: true }),
    gitHead: (w) => sh(["git", "rev-parse", "HEAD"], w),
    resolveTestAccount: (o) => resolveTestAccount({ ...o, env: process.env }),
    writeOut: (line) => console.log(line),
    writeErr: (line) => process.stderr.write(line),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2), defaultDeps()));
}
