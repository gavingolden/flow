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
  readPhaseModel,
  readReviewLensModel,
  defaultReadConfigFile,
  cachedConfigRead,
  REVIEW_LENS_NAMES,
  type ReadConfigFile,
} from "./models-config";
import {
  CONFIG_KEYS,
  resolveRouting,
  type ConfigModels,
  type ResolvedRow,
} from "./model-routing-table";
import { readLaunchDefaults } from "./launch-config";
import { readState, type ModelAlias, type PipelineState } from "./state";
import { friendlyName } from "./cost-pricing";
import { dim } from "./color";

export type ConfigModelsOptions = {
  /** Injectable config reader (test seam); defaults to the real flowConfigPath() read. */
  read?: ReadConfigFile;
  /** Injectable feature-state reader (test seam); defaults to `readState`. */
  loadState?: (slug: string) => PipelineState | null;
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

  const { rows, effort } = buildModelRows(read, state);

  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }

  console.log(`effort: ${effort.value} — ${effort.source}`);
  console.log("");
  printTable(rows);
  return 0;
}

export type ModelRows = {
  rows: ResolvedRow[];
  effort: { value: string; source: string };
};

/**
 * Pure(ish) row-builder over an already-resolved `read` + `state`: resolves
 * the session effort (state > `launch.effort` > built-in), reads every
 * `CONFIG_KEYS` grain plus the nested `reviewLenses` object, and feeds both
 * into `resolveRouting`. Extracted so `flow config all` can compose this
 * section without re-parsing `~/.flow/config.json`.
 */
export function buildModelRows(
  read: ReadConfigFile,
  state: PipelineState | null,
): ModelRows {
  const config: ConfigModels = {};
  for (const key of CONFIG_KEYS) {
    config[key] = readPhaseModel(key, read);
  }
  // Nested grain, kept out of CONFIG_KEYS (see model-routing-table.ts's
  // `fineGrainAbove` doc comment) — read one lens at a time and fold into a
  // `reviewLenses` object `resolveRouting`'s `resolveFineGrain` walks.
  const reviewLenses: Partial<Record<string, ModelAlias>> = {};
  for (const lens of REVIEW_LENS_NAMES) {
    const v = readReviewLensModel(lens, read);
    if (v) reviewLenses[lens] = v;
  }
  config.reviewLenses = reviewLenses;

  const effort = resolveSessionEffort(state, read);
  const rows = resolveRouting({ state, config, effort });
  return { rows, effort };
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

function printTable(rows: ResolvedRow[]): void {
  type Col = { header: string; get: (r: ResolvedRow) => string };
  const cols: Col[] = [
    { header: "PHASE", get: (r) => r.phase },
    {
      header: "MODEL",
      get: (r) => (r.model ? friendlyName(r.model) : "inherited"),
    },
    { header: "SOURCE", get: (r) => r.source },
    { header: "EFFORT", get: (r) => r.effort },
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
  console.log(
    dim(
      "effort is fixed when the pipeline launches; MODEL resolves at each spawn",
    ),
  );
  console.log(
    dim(
      "the Task tool has no per-spawn effort argument, so every sub-agent follows the session",
    ),
  );
}
