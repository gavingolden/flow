/**
 * `flow config all` — the single place that answers "what is my whole
 * flow config?". Composes the three existing per-view row-builders
 * (`config-models.ts`, `config-launch.ts`, `config-settings.ts`) into three
 * timing-labelled sections over ONE shared cached config read, rather than
 * adding a fourth+ subcommand per group (rejected — see the plan's excluded
 * paths).
 */

import { argsContainHelp, printVerbHelp } from "./help";
import {
  defaultReadConfigFile,
  cachedConfigRead,
  type ReadConfigFile,
} from "./models-config";
import { friendlyName } from "./cost-pricing";
import { buildModelRows, type ModelRows } from "./config-models";
import { collectLaunchConfigWarnings } from "./launch-config";
import { buildLaunchRows, type Row as LaunchRow } from "./config-launch";
import { buildSettingsRows, type SettingRow } from "./config-settings";
import { readState, type PipelineState } from "./state";
import { dim } from "./color";
import type { ConfigModelsOptions } from "./config-models";

const MODELS_TIMING =
  "resolved at each sub-agent spawn — a config edit changes the next spawn";
const LAUNCH_TIMING =
  "fixed when a pipeline launches — a config edit changes only the next launch";
const SETTINGS_TIMING =
  "read each time a helper runs — a config edit takes effect on the next invocation";

type Group = {
  group: string;
  timing: string;
  rows: unknown[];
};

export function runConfigAllCli(
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
        console.error("flow config all: --slug requires a value");
        return 2;
      }
    } else {
      console.error(`flow config all: unknown option '${arg}'`);
      console.error("usage: flow config all [--slug <name>] [--json]");
      return 2;
    }
  }

  let state: PipelineState | null = null;
  if (slug !== undefined) {
    const load = options.loadState ?? readState;
    state = load(slug);
    if (!state) {
      console.error(`flow config all: no feature pipeline '${slug}'`);
      return 1;
    }
  }

  // ONE shared cached read across all three sections — the ~10x-reread
  // foot-gun `config-models.ts` already learned from, now at aggregate scale.
  const read: ReadConfigFile = cachedConfigRead(
    options.read ?? defaultReadConfigFile,
  );

  for (const w of collectLaunchConfigWarnings(read)) {
    console.error(dim(`flow config all: ${w}`));
  }

  const models: ModelRows = buildModelRows(read, state);
  const launchRows: LaunchRow[] = buildLaunchRows(read, state);
  const settingsRows: SettingRow[] = buildSettingsRows(read);

  const groups: Group[] = [
    { group: "models", timing: MODELS_TIMING, rows: models.rows },
    { group: "launch", timing: LAUNCH_TIMING, rows: launchRows },
    { group: "settings", timing: SETTINGS_TIMING, rows: settingsRows },
  ];

  if (json) {
    console.log(JSON.stringify({ groups }));
    return 0;
  }

  console.log(`models — ${MODELS_TIMING}`);
  console.log(`effort: ${models.effort.value} — ${models.effort.source}`);
  console.log("");
  printRows(
    [
      { header: "PHASE", get: (r: (typeof models.rows)[number]) => r.phase },
      {
        header: "MODEL",
        get: (r: (typeof models.rows)[number]) =>
          r.model ? friendlyName(r.model) : "inherited",
      },
      { header: "SOURCE", get: (r: (typeof models.rows)[number]) => r.source },
      { header: "EFFORT", get: (r: (typeof models.rows)[number]) => r.effort },
    ],
    models.rows,
  );
  console.log("");

  console.log(`launch — ${LAUNCH_TIMING}`);
  console.log("");
  printRows(
    [
      { header: "SETTING", get: (r: LaunchRow) => r.setting },
      { header: "VALUE", get: (r: LaunchRow) => r.value },
      { header: "SOURCE", get: (r: LaunchRow) => r.source },
    ],
    launchRows,
  );
  console.log("");

  console.log(`settings — ${SETTINGS_TIMING}`);
  console.log("");
  printRows(
    [
      { header: "SETTING", get: (r: SettingRow) => r.setting },
      { header: "MEANING", get: (r: SettingRow) => r.meaning },
      { header: "VALUE", get: (r: SettingRow) => r.value },
      { header: "SOURCE", get: (r: SettingRow) => r.source },
    ],
    settingsRows,
  );

  return 0;
}

function printRows<T>(
  cols: { header: string; get: (r: T) => string }[],
  rows: T[],
): void {
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
}
