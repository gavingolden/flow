/**
 * `flow config models` — render the effective model + effort routing for every
 * pipeline phase and fan-out sub-agent, showing where each value resolved from.
 *
 * Read-only audit surface: reads `~/.flow/config.json` (tolerantly, via
 * `models-config.ts`) and — with `--slug` — a feature `~/.flow/state/<slug>.json`,
 * feeds both into the pure `resolveRouting`, and prints an aligned table or
 * `--json`. It changes no routing behaviour; a value mismatch is a bug in the
 * table (pinned to `model-routing.md` by a drift lint), not a new routing rule.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import {
  defaultReadConfigFile,
  cachedConfigRead,
  type ReadConfigFile,
} from "./models-config";
import { resolveRouting, type ResolvedRow } from "./model-routing-table";
import { readConfigModels } from "./read-config-models";
import { readEffortsConfig } from "./efforts-config";
import {
  detectClaudeBuild,
  MIN_SUBAGENT_EFFORT_VERSION,
  supportsSubagentEffort,
} from "./claude-build";
import { readLaunchDefaults } from "./launch-config";
import { readState, EFFORT_LEVELS, type PipelineState } from "./state";
import { friendlyName } from "./cost-pricing";
import { dim } from "./color";

/**
 * The two dim footer lines that explain the models table's `= session`
 * vocabulary and how EFFORT resolves per row. Exported so `config-all.ts`'s
 * aggregate view prints the identical text under its own models section
 * rather than letting the two views drift.
 */
export const MODEL_FOOTERS: readonly string[] = [
  "MODEL and EFFORT both resolve at each spawn; set a row's effort with efforts.<key> (same key as models.*) — needs Claude Code 2.1.292+",
  "EFFORT `= session` follows the session; fix-applier and UI driver default to medium (never above the session), the product reviewer to medium; CLAUDE_CODE_EFFORT_LEVEL overrides every row",
];

/**
 * One EFFORT-cell string per row, shared by `flow config models` and
 * `flow config all` so the two views cannot drift. `sessionKnown` is whether
 * the session's effort is known: a capped built-in row then reads
 * `≤ medium` rather than claiming the level it would only reach on a
 * high-enough session.
 */
export function formatEffortCell(
  row: ResolvedRow,
  sessionKnown: boolean = true,
): string {
  if (row.phase === "session" || row.effort === "= session") return row.effort;
  if (row.effortSource.startsWith("env")) return `${row.effort} · env`;
  if (row.effortSource.startsWith("config")) return `${row.effort} · config`;
  if (row.effortSource.startsWith("built-in")) {
    const capped = row.effortSource.includes("≤ session");
    return `${capped && !sessionKnown ? "≤ " : ""}${row.effort} · built-in`;
  }
  return row.effort;
}

/** Whether the session's effort is a concrete level (vs. the `(none)` display value). */
export function isSessionEffortKnown(models: ModelRows): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(models.effort.value);
}

/** Banner lines printed above the models table (empty when nothing to warn about). */
export function effortBanners(models: ModelRows): string[] {
  const banners: string[] = [];
  if (models.envEffort) {
    banners.push(
      `CLAUDE_CODE_EFFORT_LEVEL=${models.envEffort} overrides the effort of every sub-agent (settings-file env entries count too), so the per-row efforts below are not in effect.`,
    );
  }
  if (models.buildTooOld) {
    banners.push(
      `This Claude Code build predates per-spawn sub-agent effort (needs ${MIN_SUBAGENT_EFFORT_VERSION}+): only agent-file values apply — fix-applier, UI driver and the product reviewer run at medium, the rest follow the session.`,
    );
  }
  return banners;
}

export type ConfigModelsOptions = {
  /** Injectable config reader (test seam); defaults to the real flowConfigPath() read. */
  read?: ReadConfigFile;
  /** Injectable feature-state reader (test seam); defaults to `readState`. */
  loadState?: (slug: string) => PipelineState | null;
  /** Injectable environment (test seam); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/**
 * CLI shim for `flow config models`. Intercepts `--help` first, parses
 * `--slug`/`--json`, rejects unknown options with exit 2, resolves the routing,
 * and prints a table or JSON. An explicit `--slug` naming a pipeline with no
 * state file is a hard error (exit 1, stderr, no table) — an explicit
 * foreground audit query must fail loudly, not degrade to the global view.
 */
export function runConfigModelsCli(
  args: string[],
  options: ConfigModelsOptions = {},
): number {
  if (argsContainHelp(args)) {
    printVerbHelp("config");
    return 0;
  }

  let slug: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--slug") {
      slug = args[++i];
      if (slug === undefined) {
        console.error("flow config models: --slug requires a value");
        return 2;
      }
    } else {
      console.error(`flow config models: unknown option '${arg}'`);
      console.error("usage: flow config models [--slug <name>] [--json]");
      return 2;
    }
  }

  let state: PipelineState | null = null;
  if (slug !== undefined) {
    const load = options.loadState ?? readState;
    state = load(slug);
    if (!state) {
      // Explicit foreground query: hard-fail rather than silently showing the
      // global view (a typo'd slug must not read as "overrides wiped").
      console.error(`flow config models: no feature pipeline '${slug}'`);
      return 1;
    }
  }

  // Read + parse `~/.flow/config.json` once and reuse across every
  // `CONFIG_KEYS` entry — `readPhaseModel`'s default reader otherwise
  // re-reads/re-parses the file from scratch per phase (~10x per invocation).
  const read: ReadConfigFile = cachedConfigRead(
    options.read ?? defaultReadConfigFile,
  );

  const modelRows = buildModelRows(read, state, options.env);
  const { rows, effort } = modelRows;

  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }

  for (const banner of effortBanners(modelRows)) console.log(banner);
  console.log(`effort: ${effort.value} — ${effort.source}`);
  console.log("");
  printTable(rows, isSessionEffortKnown(modelRows));
  return 0;
}

export type ModelRows = {
  rows: ResolvedRow[];
  effort: { value: string; source: string };
  /** `CLAUDE_CODE_EFFORT_LEVEL` when set to a valid level: it overrides every sub-agent. */
  envEffort?: string;
  /** The running build is detectably older than the per-spawn effort floor. */
  buildTooOld?: boolean;
};

/**
 * Pure(ish) row-builder over an already-resolved `read` + `state`: resolves
 * the session effort (state > `launch.effort` > built-in), reads every
 * `models.*` and `efforts.*` grain, and feeds them into `resolveRouting`.
 * Extracted so `flow config all` can compose this section without
 * re-parsing `~/.flow/config.json`.
 */
export function buildModelRows(
  read: ReadConfigFile,
  state: PipelineState | null,
  env: NodeJS.ProcessEnv = process.env,
): ModelRows {
  const config = readConfigModels(read);
  const efforts = readEffortsConfig(read);
  const rawEnv = env.CLAUDE_CODE_EFFORT_LEVEL;
  const envEffort =
    rawEnv && (EFFORT_LEVELS as readonly string[]).includes(rawEnv)
      ? rawEnv
      : undefined;
  const effort = resolveSessionEffort(state, read);
  const rows = resolveRouting({ state, config, effort, efforts, envEffort });
  const buildTooOld =
    detectClaudeBuild(env) !== null && !supportsSubagentEffort(env);
  return { rows, effort, envEffort, buildTooOld };
}

/**
 * Resolves the session's effort on the same precedence ladder
 * `config-launch.ts` uses for every other `launch.<key>`: this run's frozen
 * state > `launch.effort` > built-in. Reuses the SAME three source-string
 * literals so the two audit views never describe identical resolutions in
 * different words. Once an explicit `--slug` resolved a state file, config
 * is no longer in the chain (same rule `config-launch.ts` documents) — an
 * absent `state.effort` there means "resolved to the built-in", never "go
 * re-read the live config".
 */
function resolveSessionEffort(
  state: PipelineState | null,
  read: ReadConfigFile,
): { value: string; source: string } {
  if (state) {
    if (state.effort !== undefined) {
      return {
        value: String(state.effort),
        source: "this run (fixed at launch)",
      };
    }
    return { value: "(none)", source: "built-in (no --effort passed)" };
  }
  const launchDefaults = readLaunchDefaults(read);
  if (launchDefaults.effort !== undefined) {
    return {
      value: String(launchDefaults.effort),
      source: "config (launch.effort)",
    };
  }
  return { value: "(none)", source: "built-in (no --effort passed)" };
}

function printTable(rows: ResolvedRow[], sessionKnown: boolean): void {
  type Col = { header: string; get: (r: ResolvedRow) => string };
  const cols: Col[] = [
    { header: "PHASE", get: (r) => r.phase },
    {
      header: "MODEL",
      // Deliberately NOT the EFFORT column's `= session`: an unset model
      // INHERITS the session model, an unset effort FOLLOWS the session's
      // effort. Both resolve per spawn, but they are independent axes with
      // independent overrides; one word for both would blur that.
      get: (r) => (r.model ? friendlyName(r.model) : "inherited"),
    },
    { header: "SOURCE", get: (r) => r.source },
    { header: "EFFORT", get: (r) => formatEffortCell(r, sessionKnown) },
  ];
  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();

  console.log(line(cols.map((c) => c.header)));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
  console.log("");
  console.log(dim("routing only — see `flow ls --cost` for realized spend"));
  for (const footer of MODEL_FOOTERS) console.log(dim(footer));
}
