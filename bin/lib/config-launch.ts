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
  type LaunchDefaults,
  type ReadConfigFile,
} from "./launch-config";
import { defaultReadConfigFile, readDefaultModel } from "./models-config";
import { readState, type PipelineState } from "./state";
import { dim } from "./color";

export type ConfigLaunchOptions = {
  /** Injectable config reader (test seam); defaults to the real flowConfigPath() read. */
  read?: ReadConfigFile;
  /** Injectable feature-state reader (test seam); defaults to `readState`. */
  loadState?: (slug: string) => PipelineState | null;
};

type Row = { setting: string; value: string; source: string };

/** The `flow feature create` flag(s) that set a given launch key/value pair. */
function flagFor(key: keyof LaunchDefaults, value: unknown): string {
  switch (key) {
    case "effort":
      return "--effort";
    case "autoMerge":
      return value === true ? "--auto-merge" : "--no-auto-merge";
    case "waitForCopilot":
      return value === true ? "--wait-for-copilot" : "--no-wait-for-copilot";
    case "forceResearch":
      return value === true ? "--research" : "--no-research";
    case "interviewMode":
      return value === "force" ? "--interview" : "--no-interview";
  }
}

const BUILT_IN: Record<keyof LaunchDefaults, { value: string; note: string }> =
  {
    effort: { value: "(none)", note: "no --effort passed" },
    autoMerge: { value: "true", note: "auto-merge ON" },
    waitForCopilot: { value: "false", note: "auto-detect skips" },
    forceResearch: { value: "false", note: "not forced" },
    interviewMode: {
      value: "(none)",
      note: "interview-playbook judgment gate",
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
  // readLaunchDefaults already caches internally, but readDefaultModel below
  // is a SEPARATE reader; share the same cached closure so the file is
  // parsed exactly once per invocation regardless.
  let cached: unknown;
  let cachedRead = false;
  const baseRead = options.read ?? defaultReadConfigFile;
  const read: ReadConfigFile = () => {
    if (!cachedRead) {
      cached = baseRead();
      cachedRead = true;
    }
    return cached;
  };

  const configDefaults = readLaunchDefaults(read);
  const rows: Row[] = LAUNCH_CONFIG_KEYS.map((entry) => {
    const stateValue = state
      ? (state as unknown as Record<string, unknown>)[entry.stateField]
      : undefined;
    if (stateValue !== undefined) {
      return {
        setting: entry.key,
        value: String(stateValue),
        source: `state (${flagFor(entry.key, stateValue)})`,
      };
    }
    const configValue = configDefaults[entry.key];
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
  // before an expensive run see the model in the same glance.
  const model = readDefaultModel(read);
  rows.push({
    setting: "model",
    value: model ?? "(none)",
    source: model ? "config (models.default)" : "built-in (inherited default)",
  });

  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }

  printTable(rows);
  return 0;
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
  console.log(
    dim(
      "a config edit changes the NEXT launch only, never a pipeline already running",
    ),
  );
}
