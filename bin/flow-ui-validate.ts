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
 * Two decision modes, plus two utility modes that need no manifest:
 *
 *   SKIP-DECISION (pre-flight, before any browser driving):
 *     flow-ui-validate [--manifest <path>] [--mcp-absent]
 *                      [--changed-files <path>]   (or changed paths via stdin)
 *   ASSEMBLE (after the skill has driven MCP and written captures):
 *     flow-ui-validate [--manifest <path>] --captures <path>
 *
 *   PAGE SCRIPTS: flow-ui-validate --probe-script | --sections-script |
 *                 --sections-restore-script  (print the JS the driver runs)
 *   COMPARE: flow-ui-validate --compare <before.json> <after.json>
 *            (keep/revert verdict between two ASSEMBLE outputs)
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
import {
  compareFindings,
  computeViewportFindings,
  filterCapture,
} from "./lib/ui-viewport-findings";
import type { Captures, RouteFindings } from "./lib/ui-viewport-findings";
import {
  heuristicsProbeScript,
  sectionsRestoreScript,
  sectionsScript,
} from "./lib/ui-heuristics";
import type {
  UiValidationManifest,
  Viewport,
} from "./lib/ui-validation-schema";
import { deriveRoutes } from "./lib/ui-route-infer";
import {
  inferLaunch,
  allocFreePorts,
  collectPortSentinels,
  resolvePorts,
} from "./lib/ui-launch-infer";
import { inferAuth } from "./lib/ui-auth-infer";

// --- Types -----------------------------------------------------------------

export type SkippedReason =
  | "mcp-not-available"
  | "no-ui-manifest"
  | "app-launch-failed"
  | "login-failed"
  | "browser-profile-busy";

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
   * Present in SKIP-DECISION ready output AND in BOOTSTRAP output (bootstrap
   * carries only `launch`/`baseUrl`/`port`/`env: {}`, with {{PORT}} resolved to
   * a freshly-allocated port, and only when a launch was inferred and a port
   * could be allocated): `baseUrl`/`launch`/`loginUrl`/
   * `disableAnimations`/`env`/`viewports`, plus an optional `port: number`
   * emitted ONLY when the bare {{PORT}} sentinel in the manifest actually
   * resolved to a freshly-allocated free port this run, and/or an optional
   * `ports: Record<string, number>` emitted ONLY when at least one
   * `{{PORT_<NAME>}}` named sentinel resolved this run (keyed by name, e.g.
   * `ports.BACKEND`) — each distinct sentinel gets its own freshly-allocated
   * port. A literal-port manifest never gets a `port`/`ports` key —
   * meta.launch/meta.baseUrl/meta.loginUrl are byte-identical to the
   * manifest in that case. `loginUrl` is resolved against the same per-run
   * ports as launch/baseUrl/env when present.
   */
  meta?: Record<string, unknown>;
};

export type Args = {
  manifest: string;
  mcpAbsent: boolean;
  browserBusy: boolean;
  changedFiles?: string;
  captures?: string;
  /** Page-script modes: print one driver script and exit, no manifest needed. */
  script?: "probe" | "sections" | "sections-restore";
  /** `--compare <before.json> <after.json>`: keep/revert between two ASSEMBLE outputs. */
  compare?: [string, string];
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
  /** Per-run free-port provider for the ready path's {{PORT}}/{{PORT_<NAME>}}
   * resolution. Sync by design — the main() IIFE pre-allocates a pool via
   * `allocFreePorts()` once and injects a closure that slices `count`
   * distinct ports off that pool, so `run()` itself stays synchronous (the
   * test harness calls it synchronously). Called only when the manifest
   * actually carries a port sentinel; a short returned array (fewer than
   * `count` ports) is treated as an allocation failure and the manifest is
   * emitted unresolved. */
  allocPorts?: (count: number) => number[];
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
  flow-ui-validate --probe-script | --sections-script | --sections-restore-script
  flow-ui-validate --compare <before.json> <after.json>

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
  --probe-script          Print the page-quality probe the driver hands to
                          evaluate_script, then exit 0.
  --sections-script       Print the script that opens collapsed <details> and
                          lists the page's sections, then exit 0.
  --sections-restore-script
                          Print the script that re-closes what
                          --sections-script opened, then exit 0.
  --compare <b> <a>       Compare two ASSEMBLE outputs (before, after) and
                          print {"decision":"keep"|"revert",...}.
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
      case "--probe-script":
        out.script = "probe";
        continue;
      case "--sections-script":
        out.script = "sections";
        continue;
      case "--sections-restore-script":
        out.script = "sections-restore";
        continue;
      case "--compare": {
        const after = argv[i + 2];
        if (
          !value ||
          value.startsWith("--") ||
          !after ||
          after.startsWith("--")
        ) {
          return { error: "--compare requires <before.json> <after.json>" };
        }
        out.compare = [value, after];
        i += 2;
        continue;
      }
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

// `.svelte.ts`/`.svelte.js` are Svelte 5 runes modules: `.endsWith(".svelte")`
// is false for e.g. "cart.svelte.ts", so a shared-reactive-state module would
// otherwise be invisible to UI validation unless it happened to sit under a
// routes/ or components/ path. They carry no route of their own, so they are
// NOT added to COMPONENT_EXTENSIONS below — treated like a bare `.css` token:
// counted as a UI file, but not by itself a meaningful render surface.
export const UI_EXTENSIONS = [
  ".svelte",
  ".css",
  ".scss",
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte.ts",
  ".svelte.js",
];

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
      "usage: flow-ui-validate [--manifest <path>] [--mcp-absent] [--browser-busy] [--changed-files <path>] | --captures <path> | --probe-script | --sections-script | --sections-restore-script | --compare <before.json> <after.json>\n",
    );
    return 2;
  }

  const emit = (env: UiValidateEnvelope): number => {
    writeOut(JSON.stringify(env) + "\n");
    return 0;
  };

  // Page scripts and --compare need no manifest, so they short-circuit before
  // the manifest load below.
  if (parsed.script !== undefined) {
    const scripts = {
      probe: heuristicsProbeScript,
      sections: sectionsScript,
      "sections-restore": sectionsRestoreScript,
    };
    writeOut(scripts[parsed.script]() + "\n");
    return 0;
  }
  if (parsed.compare !== undefined) {
    const read = (p: string): unknown => {
      const raw = readFile(p);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const [before, after] = parsed.compare.map(read);
    for (const [name, doc] of [
      [parsed.compare[0], before],
      [parsed.compare[1], after],
    ] as const) {
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        writeErr(
          `flow-ui-validate: --compare file unreadable or malformed: ${name}\n`,
        );
        return 2;
      }
    }
    writeOut(
      JSON.stringify(
        compareFindings(
          before as { routes?: RouteFindings[] },
          after as { routes?: RouteFindings[] },
        ),
      ) + "\n",
    );
    return 0;
  }

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
        "Another flow pipeline is holding chrome-devtools-mcp's shared Chrome profile (~/.cache/chrome-devtools-mcp/chrome-profile). Register the chrome-devtools MCP with --isolated in ~/.claude.json so each pipeline gets its own auto-cleaned throwaway profile, or wait for/close the other pipeline's browser. --isolated resolves the profile LOCK, but a busy profile often means a previous session's browser was never closed — run flow-browser-teardown (session-scoped) or flow reap --include-strays (sessionless strays; flow-browser-teardown --orphans is deprecated in favor of this) to reap it. UI validation was skipped for this run; verify/review proceeded on the rest of the diff.",
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
        // Top-level launch/baseUrl keep the {{PORT}} form for the manifest
        // write-back; meta carries the same launch resolved to one freshly
        // allocated port so `flow-spawn --from-envelope` can run it directly.
        const pool = deps.allocPorts?.(1) ?? [];
        if (pool.length >= 1) {
          const bare = pool[0];
          env.meta = {
            launch: resolvePorts(launchInfo.launch, { bare }),
            baseUrl: resolvePorts(launchInfo.baseUrl, { bare }),
            port: bare,
            env: {},
          };
        }
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

    // Absent launch/login fields mean "not reported": a run that captured a
    // snapshot clearly launched and logged in. Only an explicit `false`, or
    // absence with nothing captured, is a failure.
    const capturedAny = captures.routes.some(
      (c) =>
        (typeof c.snapshotText === "string" && c.snapshotText.length > 0) ||
        (c.viewports ?? []).some((v) => (v.snapshotText ?? "").length > 0),
    );
    const failed = (v: boolean | undefined): boolean =>
      v === false || (v === undefined && !capturedAny);
    if (failed(captures.launchOk)) {
      return emit({
        ran: false,
        loud: true,
        skipped_reason: "app-launch-failed",
        nudge: `manifest present but the dev server (${manifest.launch}) did not start — check the launch command and that the app builds`,
      });
    }
    if (failed(captures.loginOk)) {
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
  // Per-run port resolution: collect the distinct sentinel SET across the
  // manifest (the bare {{PORT}} sentinel — which can only appear here if it
  // also appears in baseUrl, per the schema's bidirectional invariant — plus
  // every distinct {{PORT_<NAME>}} named sentinel), allocate one fresh free
  // port PER distinct sentinel, and resolve every occurrence, so two
  // concurrent pipelines never collide on a frozen port and two named
  // sentinels in the same manifest never collide with each other. A
  // manifest with no sentinel is emitted verbatim, unchanged from before.
  const sentinelValues = [
    manifest.launch,
    manifest.baseUrl,
    manifest.loginUrl,
    ...Object.values(manifest.env ?? {}),
  ].filter((v): v is string => typeof v === "string");
  const sentinels = collectPortSentinels(sentinelValues);
  const requiredCount = sentinels.named.length + (sentinels.bare ? 1 : 0);

  let launch = manifest.launch;
  let baseUrl = manifest.baseUrl;
  let loginUrl = manifest.loginUrl;
  let env = manifest.env ?? {};
  let resolvedPort: number | undefined;
  let resolvedPorts: Record<string, number> | undefined;
  if (requiredCount > 0 && deps.allocPorts) {
    const pool = deps.allocPorts(requiredCount);
    if (pool.length >= requiredCount) {
      const named: Record<string, number> = {};
      let cursor = 0;
      for (const name of sentinels.named) {
        named[name] = pool[cursor];
        cursor++;
      }
      const bare = sentinels.bare ? pool[cursor] : undefined;
      const resolveOpts = { bare, named };
      launch = resolvePorts(launch, resolveOpts);
      baseUrl = resolvePorts(baseUrl, resolveOpts);
      if (loginUrl != null) loginUrl = resolvePorts(loginUrl, resolveOpts);
      env = Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, resolvePorts(v, resolveOpts)]),
      );
      resolvedPort = bare;
      if (sentinels.named.length > 0) resolvedPorts = named;
    }
  }

  const meta: Record<string, unknown> = {
    baseUrl,
    launch,
    loginUrl: loginUrl ?? null,
    disableAnimations: manifest.disableAnimations ?? false,
    env,
    viewports: manifest.viewports ?? DEFAULT_VIEWPORTS,
  };
  if (resolvedPort !== undefined) meta.port = resolvedPort;
  if (resolvedPorts !== undefined) meta.ports = resolvedPorts;

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

// Sized to comfortably cover any manifest's distinct-sentinel count in one
// run (bare {{PORT}} plus a handful of named {{PORT_<NAME>}} sentinels).
export const PORT_POOL_SIZE = 8;

if (import.meta.main) {
  // allocFreePorts is best-effort (binds :0 per port, could race another
  // process for an assigned port before the caller re-binds it): a rejection
  // here must degrade to an ordinary downstream launch failure, never an
  // unhandled top-level rejection. Falling back to no allocPorts means a
  // port-sentinel-bearing manifest is emitted unresolved, which the launch
  // step then fails on exactly like any other bad launch command.
  let pool: number[] = [];
  try {
    pool = await allocFreePorts(PORT_POOL_SIZE);
  } catch {
    pool = [];
  }
  process.exit(
    run(
      process.argv.slice(2),
      pool.length > 0 ? { allocPorts: (n: number) => pool.slice(0, n) } : {},
    ),
  );
}
