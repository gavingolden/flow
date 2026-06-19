#!/usr/bin/env bun
/**
 * LLM-free core of the browser-driven UI-validation capability. It owns the
 * deterministic, testable mechanics — MCP-presence handling (it is *told*
 * via `--mcp-absent`, never probes), manifest parse/validate, the
 * conditionally-loud skip matrix, and per-route findings assembly — while
 * the actual `mcp__chrome-devtools__*` tool calls (navigate/snapshot/
 * console/network/screenshot) live in the consuming skill prose (Step 6
 * `/verify`, Step 8c `/pr-review`), because MCP tools are harness-level
 * calls, not importable functions. This keeps the no-nested-LLM constraint
 * intact: this helper never spawns `claude -p` or a Task.
 *
 * Two modes:
 *
 *   SKIP-DECISION (pre-flight, before any browser driving):
 *     flow-ui-validate [--manifest <path>] [--mcp-absent]
 *                      [--changed-files <path>]   (or changed paths via stdin)
 *   ASSEMBLE (after the skill has driven MCP and written captures):
 *     flow-ui-validate [--manifest <path>] --captures <path>
 *
 * Output: a single JSON envelope on stdout, always carrying `ran` + `loud`
 * (+ optional `skipped_reason` / `nudge`). Exit codes mirror
 * flow-pr-static-analysis:
 *   0 — envelope emitted (any skip is still a verdict)
 *   2 — bad CLI args
 */

import * as fs from "node:fs";

import { validateUiValidationManifest } from "./lib/ui-validation-schema";
import type { UiValidationManifest } from "./lib/ui-validation-schema";

// --- Types -----------------------------------------------------------------

export type SkippedReason =
  | "mcp-not-available"
  | "no-ui-manifest"
  | "app-launch-failed"
  | "login-failed";

export type RouteFindings = {
  path: string;
  ok: boolean;
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
};

export type ReadyRoute = {
  path: string;
  expectSelectors: string[];
};

export type UiValidateEnvelope = {
  ran: boolean;
  loud: boolean;
  skipped_reason?: SkippedReason;
  nudge?: string;
  /** Present in SKIP-DECISION ready output: normalized manifest routes to drive. */
  routes?: ReadyRoute[] | RouteFindings[];
  /** Present in ASSEMBLE output: true iff every route passed. */
  ok?: boolean;
  evidence_paths?: string[];
  meta?: Record<string, unknown>;
};

export type Captures = {
  launchOk: boolean;
  loginOk: boolean;
  routes: Array<{
    path: string;
    consoleErrors: string[];
    failedRequests: string[];
    snapshotText: string;
    screenshotPath?: string;
  }>;
};

export type Args = {
  manifest: string;
  mcpAbsent: boolean;
  changedFiles?: string;
  captures?: string;
};

export type Deps = {
  readFile?: (p: string) => string | null;
  fileExists?: (p: string) => boolean;
  readStdin?: () => string;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
};

const DEFAULT_MANIFEST = ".flow/ui-validation.json";

export const HELP_TEXT = `flow-ui-validate — LLM-free core of browser-driven UI validation

Usage:
  flow-ui-validate [--manifest <path>] [--mcp-absent] [--changed-files <path>]
  flow-ui-validate [--manifest <path>] --captures <path>

Options:
  --manifest <path>       Path to the .flow/ui-validation.json manifest
                          (default ${DEFAULT_MANIFEST}).
  --mcp-absent            The chrome-devtools MCP is not available in this
                          session; emit a quiet mcp-not-available skip.
  --changed-files <path>  File with newline-separated changed paths (the
                          diff-touches-UI signal). Also accepted via stdin.
  --captures <path>       ASSEMBLE mode: a JSON file the skill writes after
                          driving the MCP per route.
  --help, -h              Show this help.

Exit codes:
  0  envelope emitted (any skip is still a verdict)
  2  argument-parse error`;

// --- CLI -------------------------------------------------------------------

export function parseArgs(
  argv: string[],
): Args | { error: string } | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const out: Args = { manifest: DEFAULT_MANIFEST, mcpAbsent: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--mcp-absent":
        out.mcpAbsent = true;
        continue;
      case "--manifest":
        if (!value || value.startsWith("--")) {
          return { error: "--manifest requires a value" };
        }
        out.manifest = value;
        i++;
        continue;
      case "--changed-files":
        if (!value || value.startsWith("--")) {
          return { error: "--changed-files requires a value" };
        }
        out.changedFiles = value;
        i++;
        continue;
      case "--captures":
        if (!value || value.startsWith("--")) {
          return { error: "--captures requires a value" };
        }
        out.captures = value;
        i++;
        continue;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

// --- UI-file signal --------------------------------------------------------

const UI_EXTENSIONS = [".svelte", ".css", ".scss"];

/** A changed path counts as a UI file by extension or by a UI path segment. */
export function isUiFile(p: string): boolean {
  const lower = p.toLowerCase();
  if (UI_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (lower.includes("routes/")) return true;
  if (lower.includes("/components/")) return true;
  if (lower.includes("lib/components")) return true;
  return false;
}

function parseChangedFiles(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// --- Per-route findings (ASSEMBLE) -----------------------------------------

export function computeRouteFindings(
  manifest: UiValidationManifest,
  capture: Captures["routes"][number],
): RouteFindings {
  const consoleErrors = capture.consoleErrors ?? [];
  const failedRequests = capture.failedRequests ?? [];
  const manifestRoute = manifest.routes.find((r) => r.path === capture.path);
  const expectSelectors = manifestRoute?.expectSelectors ?? [];
  const snapshotText = capture.snapshotText ?? "";
  const missingSelectors = expectSelectors.filter(
    (sel) => !snapshotText.includes(sel),
  );
  const ok =
    consoleErrors.length === 0 &&
    failedRequests.length === 0 &&
    missingSelectors.length === 0;
  return {
    path: capture.path,
    ok,
    consoleErrors,
    failedRequests,
    missingSelectors,
  };
}

// --- Runner ----------------------------------------------------------------

export function run(argv: string[], deps: Deps = {}): number {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));
  const readFile =
    deps.readFile ??
    ((p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const fileExists = deps.fileExists ?? ((p) => fs.existsSync(p));

  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    writeOut(HELP_TEXT + "\n");
    return 0;
  }
  if ("error" in parsed) {
    writeErr(`flow-ui-validate: ${parsed.error}\n`);
    writeErr(
      "usage: flow-ui-validate [--manifest <path>] [--mcp-absent] [--changed-files <path>] | --captures <path>\n",
    );
    return 2;
  }

  const emit = (env: UiValidateEnvelope): number => {
    writeOut(JSON.stringify(env) + "\n");
    return 0;
  };

  // --mcp-absent wins over every other mode: environment-level, quiet skip.
  if (parsed.mcpAbsent) {
    return emit({
      ran: false,
      loud: false,
      skipped_reason: "mcp-not-available",
    });
  }

  // Load + validate the manifest once; both modes need a valid manifest.
  const manifestRaw = fileExists(parsed.manifest)
    ? readFile(parsed.manifest)
    : null;
  let manifest: UiValidationManifest | null = null;
  if (manifestRaw !== null) {
    try {
      const json = JSON.parse(manifestRaw);
      const validated = validateUiValidationManifest(json);
      if (validated.ok) manifest = validated.value;
    } catch {
      manifest = null;
    }
  }

  if (manifest === null) {
    // Manifest missing or malformed → no-ui-manifest. Loud IFF the diff
    // touches UI files (the discovery nudge); quiet otherwise.
    const changedRaw =
      parsed.changedFiles !== undefined
        ? readFile(parsed.changedFiles)
        : deps.readStdin
          ? deps.readStdin()
          : null;
    const changed = changedRaw !== null ? parseChangedFiles(changedRaw) : [];
    const uiFiles = changed.filter(isUiFile);
    if (uiFiles.length > 0) {
      const listed = uiFiles.slice(0, 3).join(", ");
      return emit({
        ran: false,
        loud: true,
        skipped_reason: "no-ui-manifest",
        nudge: `diff touches UI (${listed}) but no .flow/ui-validation.json — copy templates/ui-validation.json.example to .flow/ui-validation.json to enable UI validation; see AGENTS.md 'Local Testing Credentials'`,
      });
    }
    return emit({ ran: false, loud: false, skipped_reason: "no-ui-manifest" });
  }

  // ASSEMBLE mode: the skill has driven the MCP and written a captures file.
  if (parsed.captures !== undefined) {
    const capturesRaw = readFile(parsed.captures);
    let captures: Captures | null = null;
    if (capturesRaw !== null) {
      try {
        captures = JSON.parse(capturesRaw) as Captures;
      } catch {
        captures = null;
      }
    }
    if (captures === null) {
      writeErr(
        `flow-ui-validate: --captures file unreadable or malformed: ${parsed.captures}\n`,
      );
      return 2;
    }

    if (!captures.launchOk) {
      return emit({
        ran: false,
        loud: true,
        skipped_reason: "app-launch-failed",
        nudge: `manifest present but the dev server (${manifest.launch}) did not start — check the launch command and that the app builds`,
      });
    }
    if (!captures.loginOk) {
      return emit({
        ran: false,
        loud: true,
        skipped_reason: "login-failed",
        nudge: `manifest present but login failed — is the seeded test user applied? check the credentialEnvVars and your seed/fixture`,
      });
    }

    const routeFindings = captures.routes.map((c) =>
      computeRouteFindings(manifest, c),
    );
    const evidencePaths = captures.routes
      .map((c) => c.screenshotPath)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    return emit({
      ran: true,
      loud: false,
      ok: routeFindings.every((r) => r.ok),
      routes: routeFindings,
      evidence_paths: evidencePaths,
      meta: { manifest_routes: manifest.routes.length },
    });
  }

  // SKIP-DECISION ready output: manifest present + valid, MCP present. List
  // the normalized routes the skill should drive, then call ASSEMBLE.
  return emit({
    ran: true,
    loud: false,
    routes: manifest.routes.map((r) => ({
      path: r.path,
      expectSelectors: r.expectSelectors ?? [],
    })),
    meta: {
      baseUrl: manifest.baseUrl,
      launch: manifest.launch,
      loginUrl: manifest.loginUrl ?? null,
      disableAnimations: manifest.disableAnimations ?? false,
    },
  });
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
