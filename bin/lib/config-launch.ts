/**
 * `flow config launch` — render the effective launch-time behaviour defaults
 * (`launch.<key>` in `~/.flow/config.json`) and where each resolved from.
 *
 * Read-only audit surface, structural clone of `config-models.ts`: reads
 * `~/.flow/config.json` (tolerantly, via `launch-config.ts`) and — with
 * `--slug` — a feature `~/.flow/state/<slug>.json`, and prints an aligned
 * table or `--json`. It changes no launch behaviour; the resolution this
 * renders is computed for real at launch time by `feature.ts`/`epic.ts`.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import {
  LAUNCH_CONFIG_KEYS,
  readLaunchDefaults,
  collectLaunchConfigWarnings,
  type LaunchDefaults,
  type ReadConfigFile,
} from "./launch-config";
import {
  defaultReadConfigFile,
  cachedConfigRead,
  readDefaultModel,
} from "./models-config";
import { readState, type PipelineState } from "./state";
import { dim } from "./color";

export type ConfigLaunchOptions = {
  /** Injectable config reader (test seam); defaults to the real flowConfigPath() read. */
  read?: ReadConfigFile;
  /** Injectable feature-state reader (test seam); defaults to `readState`. */
  loadState?: (slug: string) => PipelineState | null;
};

export type Row = { setting: string; value: string; source: string };

/**
 * The two dim footer lines this table prints. Exported so `config-all.ts`'s
 * aggregate view prints the identical text under its own launch section
 * rather than letting the two views drift.
 */
export const LAUNCH_FOOTERS: readonly string[] = [
  "a config edit changes the NEXT launch only, never a pipeline already running",
  "model is shown for reference — set it with models.default (there is no launch.model)",
];

const BUILT_IN: Record<keyof LaunchDefaults, { value: string; note: string }> =
  {
    effort: { value: "(none)", note: "no --effort passed" },
    autoMerge: { value: "true", note: "auto-merge ON" },
    waitForCopilot: {
      value: "false",
      note: "waits for Copilot only while it's still reviewing",
    },
    forceResearch: { value: "false", note: "research runs only when relevant" },
    interviewMode: {
      value: "(none)",
      note: "flow decides per run whether to interview",
    },
  };

/**
 * CLI shim for `flow config launch`. Intercepts `--help` first, parses
 * `--slug`/`--json`, rejects unknown options with exit 2, resolves the
 * launch-default rows, and prints a table or JSON. An explicit `--slug`
 * naming a pipeline with no state file is a hard error (exit 1, stderr, no
 * table) — an explicit foreground audit query must fail loudly, not degrade
 * to the global view.
 */
export function runConfigLaunchCli(
  args: string[],
  options: ConfigLaunchOptions = {},
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
        console.error("flow config launch: --slug requires a value");
        return 2;
      }
    } else {
      console.error(`flow config launch: unknown option '${arg}'`);
      console.error("usage: flow config launch [--slug <name>] [--json]");
      return 2;
    }
  }

  let state: PipelineState | null = null;
  if (slug !== undefined) {
    const load = options.loadState ?? readState;
    state = load(slug);
    if (!state) {
      console.error(`flow config launch: no feature pipeline '${slug}'`);
      return 1;
    }
  }

  // Read + parse `~/.flow/config.json` once and reuse for every row —
  // `readLaunchDefaults` and `readDefaultModel` are separate readers that
  // would otherwise each re-read/re-parse the file from scratch.
  const read: ReadConfigFile = cachedConfigRead(
    options.read ?? defaultReadConfigFile,
  );

  // Surface a rejected/malformed config value here too — this audit command
  // is exactly where a user goes to ask "why isn't my setting doing
  // anything?", so it should be the first place that answers, not just
  // `flow feature create`'s stderr on the run they already launched.
  for (const w of collectLaunchConfigWarnings(read)) {
    console.error(dim(`flow config launch: ${w}`));
  }

  const rows = buildLaunchRows(read, state);

  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }

  printTable(rows);
  return 0;
}

/**
 * Pure row-builder over an already-resolved `read` + `state`: this run's
 * frozen state > `launch.<key>` config > built-in, for each
 * `LAUNCH_CONFIG_KEYS` entry, plus the read-only `model` cross-reference row.
 * Extracted from `runConfigLaunchCli` so `flow config all` can compose this
 * section without re-parsing `~/.flow/config.json` or re-running the
 * stderr warning pass (which stays owned by the CLI shim).
 */
export function buildLaunchRows(
  read: ReadConfigFile,
  state: PipelineState | null,
): Row[] {
  // Once an explicit `--slug` resolved a state file, that state IS the
  // completed resolution for this pipeline — config is no longer in the
  // precedence chain. `feature.ts` persists the three booleans only in
  // their non-default direction, so an absent field here means "resolved to
  // the built-in", never "go re-read the live config" (a live config value
  // may have changed since this pipeline launched and would misattribute
  // today's config to a run that never saw it).
  const configDefaults = state ? undefined : readLaunchDefaults(read);
  const rows: Row[] = LAUNCH_CONFIG_KEYS.map((entry) => {
    const stateValue = state
      ? (state as unknown as Record<string, unknown>)[entry.stateField]
      : undefined;
    if (stateValue !== undefined) {
      return {
        setting: entry.key,
        value: String(stateValue),
        source: "this run (fixed at launch)",
      };
    }
    const configValue = configDefaults?.[entry.key];
    if (configValue !== undefined) {
      return {
        setting: entry.key,
        value: String(configValue),
        source: `config (launch.${entry.key})`,
      };
    }
    const builtIn = BUILT_IN[entry.key];
    return {
      setting: entry.key,
      value: builtIn.value,
      source: `built-in (${builtIn.note})`,
    };
  });

  // Read-only cross-reference row — `models.default` stays the only writable
  // home for the session model; this just lets an operator auditing effort
  // before an expensive run see the model in the same glance. With --slug,
  // `state.model` (populated whenever a model actually reached the session,
  // whether from `--model` or from config at launch time) is the completed
  // resolution, same rule as the five rows above.
  const stateModel = state?.model;
  let modelValue: string;
  let modelSource: string;
  if (stateModel !== undefined) {
    modelValue = stateModel;
    modelSource = "this run (fixed at launch)";
  } else {
    const liveModel = readDefaultModel(read);
    modelValue = liveModel ?? "(none)";
    modelSource = liveModel
      ? "config (models.default)"
      : "built-in (Claude Code's own default model)";
  }
  rows.push({ setting: "model", value: modelValue, source: modelSource });

  return rows;
}

function printTable(rows: Row[]): void {
  type Col = { header: string; get: (r: Row) => string };
  const cols: Col[] = [
    { header: "SETTING", get: (r) => r.setting },
    { header: "VALUE", get: (r) => r.value },
    { header: "SOURCE", get: (r) => r.source },
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
  for (const footer of LAUNCH_FOOTERS) console.log(dim(footer));
}
