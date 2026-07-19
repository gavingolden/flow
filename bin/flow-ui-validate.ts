#!/usr/bin/env bun
/**
 * LLM-free core of the browser-driven UI-validation capability. It owns the
 * deterministic, testable mechanics — MCP-presence handling (it is *told*
 * via `--mcp-absent`, never probes), manifest parse/validate, the
 * conditionally-loud skip matrix, and per-route findings assembly — while
 * the actual `mcp__chrome-devtools__*` tool calls (navigate/snapshot/
 * console/network/screenshot) live in the consuming skill prose (Step 6
 * `/flow-verify`, Step 8c `/flow-pr-review`), because MCP tools are harness-level
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
 *
 * Bootstrap verdict (SKIP-DECISION, no manifest yet): when the diff touches a
 * meaningful UI surface and the MCP is present, the helper deterministically
 * infers `launch`/`baseUrl`/`routes`/`loginUrl`/`credentialEnvVars` (LLM-free,
 * via the sibling `ui-*-infer` modules) and returns `action: "bootstrap"` for
 * the skill to branch on. SECRET-VALUE GUARDRAIL: the bootstrap payload — and
 * the manifest the skill persists from it — carries env-var names and
 * non-secret config only — never a secret value; `.env` VALUES are resolved
 * locally at run time and never enter the emitted JSON.
 */

import * as fs from "node:fs";

import { validateUiValidationManifest } from "./lib/ui-validation-schema";
import type {
  UiValidationManifest,
  Viewport,
} from "./lib/ui-validation-schema";
import { deriveRoutes } from "./lib/ui-route-infer";
import {
  inferLaunch,
  allocFreePort,
  resolvePortPlaceholder,
  PORT_PLACEHOLDER,
} from "./lib/ui-launch-infer";
import { inferAuth } from "./lib/ui-auth-infer";

// --- Types -----------------------------------------------------------------

export type SkippedReason =
  | "mcp-not-available"
  | "no-ui-manifest"
  | "app-launch-failed"
  | "login-failed"
  | "browser-profile-busy";

export type RouteFindings = {
  path: string;
  ok: boolean;
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
  /**
   * Per-viewport geometry failures (off-center constrained column, horizontal
   * overflow, missing-element-at-breakpoint), each naming the offending
   * viewport. Present (possibly empty) only on the per-viewport path; absent on
   * the legacy single-capture path.
   */
  geometryIssues?: string[];
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
  /**
   * SKIP-DECISION discriminator. `"bootstrap"` means: no manifest yet, but the
   * diff touches a meaningful UI surface with the MCP present, so the skill
   * should self-complete `.flow/ui-validation.json` from the inferred payload
   * below (names/config only) and empirically verify it.
   */
  action?: "bootstrap";
  /**
   * Present in SKIP-DECISION ready output: normalized manifest routes to drive.
   * On a bootstrap verdict this is the inferred `string[]` of derived routes.
   */
  routes?: ReadyRoute[] | RouteFindings[] | string[];
  /** Bootstrap payload — the inferred launch command ({{PORT}} placeholder form). */
  launch?: string;
  /** Bootstrap payload — the inferred base URL ({{PORT}} placeholder form). */
  baseUrl?: string;
  /** Bootstrap payload — the inferred login route, when a login-ish route exists. */
  loginUrl?: string;
  /** Bootstrap payload — credential env-var NAMES (never values). */
  credentialEnvVars?: { user: string; pass: string };
  /** Bootstrap payload — fields the helper could not infer (launch/routes/credentials). */
  needs?: string[];
  /** Present in ASSEMBLE output: true iff every route passed. */
  ok?: boolean;
  evidence_paths?: string[];
  /**
   * Present in SKIP-DECISION ready output: `baseUrl`/`launch`/`loginUrl`/
   * `disableAnimations`/`env`/`viewports`, plus an optional `port: number`
   * emitted ONLY when a {{PORT}} sentinel in the manifest actually resolved
   * to a freshly-allocated free port this run (a literal-port manifest never
   * gets a `port` key — meta.launch/meta.baseUrl are byte-identical to the
   * manifest in that case).
   */
  meta?: Record<string, unknown>;
};

/**
 * Per-(route × viewport) capture the driving skill writes after resizing the
 * page, driving the MCP, and reading geometry via `evaluate_script`. The
 * geometry fields (`rootGap` / `scrollWidth` / `clientWidth`) are raw NUMBERS
 * the skill measured — this helper applies pure-TypeScript tolerance/equality
 * checks to them and never drives the MCP or reads the DOM itself.
 */
export type ViewportCapture = {
  name: string;
  width: number;
  snapshotText?: string;
  consoleErrors?: string[];
  failedRequests?: string[];
  screenshotPath?: string;
  rootGap?: { left: number; right: number };
  scrollWidth?: number;
  clientWidth?: number;
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
    viewports?: ViewportCapture[];
  }>;
};

export type Args = {
  manifest: string;
  mcpAbsent: boolean;
  browserBusy: boolean;
  changedFiles?: string;
  captures?: string;
};

export type Deps = {
  readFile?: (p: string) => string | null;
  fileExists?: (p: string) => boolean;
  readStdin?: () => string;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
  /** Bootstrap inputs — dep-injected so the module tests stay filesystem-free.
   * Default to a plain `readFile` of the conventional path. */
  readPackageJson?: () => string | null;
  readEnvExample?: () => string | null;
  /** Per-run free-port provider for the ready path's {{PORT}} resolution.
   * Sync by design — the main() IIFE awaits `allocFreePort()` once and
   * injects a closure over the resolved number, so `run()` itself stays
   * synchronous (the test harness calls it synchronously). Called only when
   * the manifest actually carries a {{PORT}} sentinel. */
  allocPort?: () => number;
};

const DEFAULT_MANIFEST = ".flow/ui-validation.json";

// The widths every route is rendered at when the manifest declares no
// `viewports`. 320 satisfies WCAG 1.4.10 Reflow mechanically; 390 is
// iPhone-class; 768 tablet; 1280/1440 cover the wide-monitor centering class
// the /account regression exposed.
export const DEFAULT_VIEWPORTS: Viewport[] = [
  { name: "xs", width: 320 },
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
  { name: "wide", width: 1440 },
];

export const HELP_TEXT = `flow-ui-validate — LLM-free core of browser-driven UI validation

Usage:
  flow-ui-validate [--manifest <path>] [--mcp-absent] [--browser-busy] [--changed-files <path>]
  flow-ui-validate [--manifest <path>] --captures <path>

Options:
  --manifest <path>       Path to the .flow/ui-validation.json manifest
                          (default ${DEFAULT_MANIFEST}).
  --mcp-absent            The chrome-devtools MCP is not available in this
                          session; emit a quiet mcp-not-available skip.
  --browser-busy          Treat a busy/locked shared Chrome profile as a clean
                          skip; emit a loud browser-profile-busy skip with a
                          recovery nudge (another pipeline holds the profile).
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
  const out: Args = {
    manifest: DEFAULT_MANIFEST,
    mcpAbsent: false,
    browserBusy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--mcp-absent":
        out.mcpAbsent = true;
        continue;
      case "--browser-busy":
        out.browserBusy = true;
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

const UI_EXTENSIONS = [".svelte", ".css", ".scss", ".tsx", ".jsx", ".vue"];

// Component/page extensions — a render-bearing surface, as opposed to a bare
// stylesheet token (.css/.scss) that renders nothing on its own.
const COMPONENT_EXTENSIONS = [".svelte", ".tsx", ".jsx", ".vue"];

/** A changed path counts as a UI file by extension or by a UI path segment. */
export function isUiFile(p: string): boolean {
  const lower = p.toLowerCase();
  if (UI_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (lower.includes("routes/")) return true;
  if (lower.includes("/components/")) return true;
  if (lower.includes("lib/components")) return true;
  return false;
}

/**
 * A "meaningful" UI surface: a render-bearing component/page, or a file living
 * under a routes/components tree — as opposed to a bare `.css`/`.scss` token
 * change with no derivable route (which renders nothing on its own).
 */
function isComponentOrPage(p: string): boolean {
  const lower = p.toLowerCase();
  if (COMPONENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
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

/**
 * Filter benign-noise substrings out of a single capture's console/request
 * lists and compute its missing-selector list. Shared by both the legacy
 * single-capture path and the per-viewport fold. Substring (not regex)
 * filters: an entry is suppressed when ANY pattern is a substring of it.
 * Absent patterns => no filtering (the benign favicon 404 is the canonical
 * case, cleared via ignoreRequestPatterns: ["/favicon.ico"]). Filter BEFORE
 * computing ok so suppressed noise never fails a route.
 */
function filterCapture(
  manifest: UiValidationManifest,
  path: string,
  consoleRaw: string[] | undefined,
  failedRaw: string[] | undefined,
  snapshotRaw: string | undefined,
): {
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
} {
  const ignoreConsolePatterns = manifest.ignoreConsolePatterns ?? [];
  const ignoreRequestPatterns = manifest.ignoreRequestPatterns ?? [];
  const consoleErrors = (consoleRaw ?? []).filter(
    (e) => !ignoreConsolePatterns.some((p) => e.includes(p)),
  );
  const failedRequests = (failedRaw ?? []).filter(
    (r) => !ignoreRequestPatterns.some((p) => r.includes(p)),
  );
  const manifestRoute = manifest.routes.find((r) => r.path === path);
  const expectSelectors = manifestRoute?.expectSelectors ?? [];
  const snapshotText = snapshotRaw ?? "";
  const missingSelectors = expectSelectors.filter(
    (sel) => !snapshotText.includes(sel),
  );
  return { consoleErrors, failedRequests, missingSelectors };
}

/**
 * Per-viewport fold: compute console/request/missing-selector findings from
 * each viewport's own fields PLUS the three mechanical geometry assertions,
 * naming the offending viewport(s). Pure TypeScript over captured numbers —
 * no MCP, no DOM read.
 */
function computeViewportFindings(
  manifest: UiValidationManifest,
  capture: Captures["routes"][number],
  viewports: ViewportCapture[],
): RouteFindings {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const missingSelectors: string[] = [];
  const geometryIssues: string[] = [];

  for (const vp of viewports) {
    const filtered = filterCapture(
      manifest,
      capture.path,
      vp.consoleErrors,
      vp.failedRequests,
      vp.snapshotText,
    );
    for (const e of filtered.consoleErrors)
      consoleErrors.push(`[${vp.name}] ${e}`);
    for (const r of filtered.failedRequests)
      failedRequests.push(`[${vp.name}] ${r}`);
    // Only a viewport that actually captured a snapshot participates in the
    // missing-selector check; mirrors the withSnapshot guard on the
    // breakpoint axis below so a no-snapshot capture (filterCapture coerces
    // undefined snapshotText to "") never spuriously flags every selector.
    if (vp.snapshotText !== undefined) {
      for (const s of filtered.missingSelectors)
        missingSelectors.push(`[${vp.name}] ${s}`);
    }

    // (a) Off-center constrained column: asymmetric left/right gaps beyond a
    // small absolute floor plus a relative band, so intentional sidebars and
    // sub-pixel rounding don't false-positive.
    if (vp.rootGap) {
      const tolerance = Math.max(16, 0.05 * vp.width);
      if (Math.abs(vp.rootGap.left - vp.rootGap.right) > tolerance) {
        geometryIssues.push(
          `[${vp.name}] off-center constrained column: rootGap left=${vp.rootGap.left} right=${vp.rootGap.right} (tolerance ${tolerance})`,
        );
      }
    }

    // (b) Horizontal overflow at this viewport.
    if (
      typeof vp.scrollWidth === "number" &&
      typeof vp.clientWidth === "number" &&
      vp.scrollWidth > vp.clientWidth
    ) {
      geometryIssues.push(
        `[${vp.name}] horizontal overflow: scrollWidth=${vp.scrollWidth} > clientWidth=${vp.clientWidth}`,
      );
    }
  }

  // (c) Missing-element-at-breakpoint: a route-declared selector present in
  // SOME viewports' snapshotText but absent in another's. Only viewports that
  // actually captured a snapshot participate, so a viewport with no snapshot
  // never spuriously triggers the breakpoint mismatch.
  const manifestRoute = manifest.routes.find((r) => r.path === capture.path);
  const expectSelectors = manifestRoute?.expectSelectors ?? [];
  const withSnapshot = viewports.filter((vp) => vp.snapshotText !== undefined);
  for (const sel of expectSelectors) {
    const present = withSnapshot.filter((vp) =>
      (vp.snapshotText ?? "").includes(sel),
    );
    if (present.length > 0 && present.length < withSnapshot.length) {
      const absent = withSnapshot
        .filter((vp) => !(vp.snapshotText ?? "").includes(sel))
        .map((vp) => vp.name);
      geometryIssues.push(
        `missing-at-breakpoint: '${sel}' present at some viewports but absent at ${absent.join(", ")}`,
      );
    }
  }

  const ok =
    consoleErrors.length === 0 &&
    failedRequests.length === 0 &&
    missingSelectors.length === 0 &&
    geometryIssues.length === 0;
  return {
    path: capture.path,
    ok,
    consoleErrors,
    failedRequests,
    missingSelectors,
    geometryIssues,
  };
}

export function computeRouteFindings(
  manifest: UiValidationManifest,
  capture: Captures["routes"][number],
): RouteFindings {
  // DUAL PATH: a route carrying a non-empty viewports[] gets the per-viewport
  // fold + geometry assertions; a route without it falls through the EXACT
  // legacy route-level computation unchanged.
  if (capture.viewports && capture.viewports.length > 0) {
    return computeViewportFindings(manifest, capture, capture.viewports);
  }

  const { consoleErrors, failedRequests, missingSelectors } = filterCapture(
    manifest,
    capture.path,
    capture.consoleErrors,
    capture.failedRequests,
    capture.snapshotText,
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
      "usage: flow-ui-validate [--manifest <path>] [--mcp-absent] [--browser-busy] [--changed-files <path>] | --captures <path>\n",
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

  // --browser-busy: another pipeline holds chrome-devtools-mcp's shared Chrome
  // profile (a cross-process on-disk lock, not something this diff caused), so
  // degrade exactly like --mcp-absent — ran:false, NEVER ok:false. Loud, with a
  // recovery nudge, since --isolated is the operator-side fix and the operator
  // benefits from seeing it. ok:false would feed the 3-attempt fix loop and
  // waste a retry on an environment condition the diff didn't introduce.
  if (parsed.browserBusy) {
    return emit({
      ran: false,
      loud: true,
      skipped_reason: "browser-profile-busy",
      nudge:
        "Another flow pipeline is holding chrome-devtools-mcp's shared Chrome profile (~/.cache/chrome-devtools-mcp/chrome-profile). Register the chrome-devtools MCP with --isolated in ~/.claude.json so each pipeline gets its own auto-cleaned throwaway profile, or wait for/close the other pipeline's browser. UI validation was skipped for this run; verify/review proceeded on the rest of the diff.",
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
    // Manifest missing or malformed. The diff-touches-UI signal decides
    // between three outcomes: a mechanical bootstrap verdict (meaningful UI
    // surface, MCP present — reaching here already implies MCP present since
    // --mcp-absent returned early), a quiet not-meaningful skip (bare
    // stylesheet with no derivable route), or the quiet no-ui-manifest skip
    // (non-UI diff).
    const changedRaw =
      parsed.changedFiles !== undefined
        ? readFile(parsed.changedFiles)
        : deps.readStdin
          ? deps.readStdin()
          : null;
    const changed = changedRaw !== null ? parseChangedFiles(changedRaw) : [];
    const uiFiles = changed.filter(isUiFile);
    if (uiFiles.length > 0) {
      const routes = deriveRoutes(changed);
      // Meaningful surface: a render-bearing component/page OR ≥1 derivable
      // route. A bare .css token change with no route renders nothing on its
      // own → quiet not-meaningful skip, no bootstrap.
      const meaningful = routes.length > 0 || uiFiles.some(isComponentOrPage);
      if (!meaningful) {
        return emit({
          ran: false,
          loud: false,
          skipped_reason: "no-ui-manifest",
          nudge: `diff touches only non-rendering UI files (${uiFiles.slice(0, 3).join(", ")}) with no derivable route — nothing meaningful to browser-validate`,
        });
      }

      const readPackageJson =
        deps.readPackageJson ?? (() => readFile("package.json"));
      const readEnvExample =
        deps.readEnvExample ?? (() => readFile(".env.example"));

      const pkgText = readPackageJson();
      const launchInfo = pkgText !== null ? inferLaunch(pkgText) : null;
      const envExampleText = readEnvExample();
      // GUARDRAIL: inferAuth is passed the .env.example TEXT but returns env-var
      // NAMES only; no VALUE ever enters the payload below.
      const auth = inferAuth({
        routes,
        envExampleText: envExampleText ?? undefined,
      });

      const needs: string[] = [];
      if (!launchInfo) needs.push("launch");
      if (routes.length === 0) needs.push("routes");
      // Credentials are only "needed" when a login wall is inferable (a login
      // route exists) but no credential NAMES could be mined — the precursor
      // to the smoketest-needs-creds NEEDS HUMAN pause.
      if (auth.loginUrl && !auth.credentialEnvVars) needs.push("credentials");

      const env: UiValidateEnvelope = {
        ran: false,
        loud: true,
        action: "bootstrap",
        routes,
        needs,
      };
      if (launchInfo) {
        env.launch = launchInfo.launch;
        env.baseUrl = launchInfo.baseUrl;
      }
      if (auth.loginUrl) env.loginUrl = auth.loginUrl;
      if (auth.credentialEnvVars)
        env.credentialEnvVars = auth.credentialEnvVars;
      return emit(env);
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
    // Guard the shape we JSON.parse + cast `as Captures`: a file that parses
    // but is not an object, or omits `routes` / carries a non-array `routes`,
    // would otherwise reach `captures.routes.map(...)` below and throw an
    // uncaught TypeError, breaking the exit-0/exit-2 contract. Treat it as
    // bad CLI input, same as the malformed-JSON branch.
    if (
      captures === null ||
      typeof captures !== "object" ||
      !Array.isArray(captures.routes)
    ) {
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
    // Aggregate the route-level screenshot AND every per-viewport screenshot so
    // a per-viewport pass surfaces one evidence path per captured viewport.
    const evidencePaths = captures.routes
      .flatMap((c) => [
        c.screenshotPath,
        ...(c.viewports ?? []).map((vp) => vp.screenshotPath),
      ])
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
  //
  // Per-run {{PORT}} resolution: when the manifest carries the sentinel
  // anywhere on the server side (launch/env) — and it can ONLY carry it
  // there if it also carries it in baseUrl, per the schema's bidirectional
  // invariant — allocate one free port for this run and resolve every
  // occurrence, so two concurrent pipelines never collide on a frozen port.
  // A manifest with no sentinel is emitted verbatim, unchanged from before.
  const needsPort = [
    manifest.launch,
    manifest.baseUrl,
    ...Object.values(manifest.env ?? {}),
  ].some((v) => v.includes(PORT_PLACEHOLDER));

  let launch = manifest.launch;
  let baseUrl = manifest.baseUrl;
  let env = manifest.env ?? {};
  let resolvedPort: number | undefined;
  if (needsPort && deps.allocPort) {
    resolvedPort = deps.allocPort();
    launch = resolvePortPlaceholder(launch, resolvedPort);
    baseUrl = resolvePortPlaceholder(baseUrl, resolvedPort);
    env = Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        resolvePortPlaceholder(v, resolvedPort as number),
      ]),
    );
  }

  const meta: Record<string, unknown> = {
    baseUrl,
    launch,
    loginUrl: manifest.loginUrl ?? null,
    disableAnimations: manifest.disableAnimations ?? false,
    env,
    viewports: manifest.viewports ?? DEFAULT_VIEWPORTS,
  };
  if (resolvedPort !== undefined) meta.port = resolvedPort;

  return emit({
    ran: true,
    loud: false,
    routes: manifest.routes.map((r) => ({
      path: r.path,
      expectSelectors: r.expectSelectors ?? [],
    })),
    meta,
  });
}

if (import.meta.main) {
  // allocFreePort is best-effort (binds :0, could race another process for
  // the assigned port before the caller re-binds it): a rejection here must
  // degrade to an ordinary downstream launch failure, never an unhandled
  // top-level rejection. Falling back to no allocPort means a {{PORT}}-
  // bearing manifest is emitted unresolved, which the launch step then fails
  // on exactly like any other bad launch command.
  let port: number | undefined;
  try {
    port = await allocFreePort();
  } catch {
    port = undefined;
  }
  process.exit(
    run(
      process.argv.slice(2),
      port !== undefined ? { allocPort: () => port as number } : {},
    ),
  );
}
