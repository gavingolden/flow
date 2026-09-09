#!/usr/bin/env bun
/**
 * Runtime per-lens model resolver for `/flow-pr-review`'s Step 3 spawn loop.
 * `bin/lib/model-routing-table.ts` is an audit surface (`flow config models`)
 * that "changes no routing behaviour" per its own docstring — the model that
 * actually reaches a Task spawn has to come from somewhere that runs at spawn
 * time. This is that somewhere: it reuses `resolveModel`'s precedence chain
 * (via `resolveRouting`) against the `review-lens:<lens>` spawn site rather
 * than reimplementing it, so there is exactly one precedence implementation.
 *
 * Usage:
 *   flow-review-model <lens> [--slug <slug>] [--config <path>] [--state <path>] [--json]
 *
 * Prints the resolved model alias on stdout and exits 0. Prints NOTHING
 * (still exits 0) when resolution is "inherit, uncapped" — the caller then
 * omits `model:` on the Task spawn and inherits the session model
 * automatically. `--json` prints `{"lens","model","source"}` instead (`model`
 * is `""` for the uncapped-inherit case) for the audit path.
 *
 * Slug resolution: `--slug` wins, else the ambient `$FLOW_SLUG`, else no
 * state is read (an unattributed session resolves every lens to bare
 * inherit). `--state <path>` overrides state resolution entirely — it reads
 * that file directly instead of `~/.flow/state/<slug>.json`, for tests.
 * `--config <path>` overrides `~/.flow/config.json` the same way.
 *
 * Exit codes: 0 resolved (incl. uncapped-inherit), 2 bad args / unknown lens.
 */

import * as fs from "node:fs";
import { resolveSlugAmbient } from "./lib/session-identity";
import {
  readPhaseModel,
  readReviewLensModel,
  defaultReadConfigFile,
  REVIEW_LENS_NAMES,
  type ReadConfigFile,
  type ReviewLensName,
} from "./lib/models-config";
import {
  CONFIG_KEYS,
  resolveRouting,
  type ConfigModels,
} from "./lib/model-routing-table";
import { readState, type ModelAlias, type PipelineState } from "./lib/state";

const USAGE =
  "usage: flow-review-model <lens> [--slug <slug>] [--config <path>] [--state <path>] [--json]\n" +
  `  <lens> must be one of: ${REVIEW_LENS_NAMES.join(", ")}`;

export type FlowReviewModelDeps = {
  /** Injectable config reader (test seam); defaults to the real `~/.flow/config.json` read. */
  read?: ReadConfigFile;
  /** Injectable slug->state reader (test seam); defaults to `readState`. */
  loadState?: (slug: string) => PipelineState | null;
  /** Injectable ambient-slug resolver (test seam); defaults to `resolveSlugAmbient`. */
  resolveSlug?: () => string | null;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
};

function isReviewLensName(v: string): v is ReviewLensName {
  return (REVIEW_LENS_NAMES as readonly string[]).includes(v);
}

function fileReader(path: string): ReadConfigFile {
  return () => {
    try {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };
}

function fileStateLoader(path: string): (slug: string) => PipelineState | null {
  return () => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
      return raw as PipelineState;
    } catch {
      return null;
    }
  };
}

export function run(argv: string[], deps: FlowReviewModelDeps = {}): number {
  const stdout = deps.stdout ?? ((s: string) => console.log(s));
  const stderr = deps.stderr ?? ((s: string) => console.error(s));

  let lens: string | undefined;
  let slug: string | undefined;
  let configPath: string | undefined;
  let statePath: string | undefined;
  let json = false;

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--slug") {
      slug = argv[++i];
      if (slug === undefined) {
        stderr("flow-review-model: --slug requires a value");
        return 2;
      }
    } else if (arg === "--config") {
      configPath = argv[++i];
      if (configPath === undefined) {
        stderr("flow-review-model: --config requires a value");
        return 2;
      }
    } else if (arg === "--state") {
      statePath = argv[++i];
      if (statePath === undefined) {
        stderr("flow-review-model: --state requires a value");
        return 2;
      }
    } else if (arg === "--help" || arg === "-h") {
      stdout(USAGE);
      return 0;
    } else if (arg.startsWith("--")) {
      stderr(`flow-review-model: unknown option '${arg}'`);
      stderr(USAGE);
      return 2;
    } else {
      positionals.push(arg);
    }
  }

  lens = positionals[0];
  if (!lens || !isReviewLensName(lens)) {
    stderr(
      `flow-review-model: unknown lens '${lens ?? ""}' — expected one of: ${REVIEW_LENS_NAMES.join(", ")}`,
    );
    return 2;
  }

  const read: ReadConfigFile =
    deps.read ?? (configPath ? fileReader(configPath) : defaultReadConfigFile);

  const loadState: (slug: string) => PipelineState | null =
    deps.loadState ?? (statePath ? fileStateLoader(statePath) : readState);

  let resolvedSlug: string | undefined = slug;
  if (resolvedSlug === undefined && statePath === undefined) {
    const resolveSlug = deps.resolveSlug ?? resolveSlugAmbient;
    resolvedSlug = resolveSlug() ?? undefined;
  }

  const state: PipelineState | null =
    statePath !== undefined
      ? loadState(statePath)
      : resolvedSlug !== undefined
        ? loadState(resolvedSlug)
        : null;

  // Reuse `resolveRouting`'s precedence chain rather than reimplementing it —
  // build the same `ConfigModels` shape `flow config models` builds, then
  // pick out the one `review-lens:<lens>` row.
  const config: ConfigModels = {};
  for (const key of CONFIG_KEYS) {
    config[key] = readPhaseModel(key, read);
  }
  const reviewLenses: Partial<Record<string, ModelAlias>> = {};
  for (const l of REVIEW_LENS_NAMES) {
    const v = readReviewLensModel(l, read);
    if (v) reviewLenses[l] = v;
  }
  config.reviewLenses = reviewLenses;

  const rows = resolveRouting({ state, config });
  const row = rows.find((r) => r.phase === `review-lens:${lens}`);
  if (!row) {
    // Unreachable given `isReviewLensName` above + `SPAWN_SITES` building one
    // row per `REVIEW_LENS_NAMES` entry — guarded rather than asserted so a
    // future drift between the two lists fails loudly instead of throwing.
    stderr(`flow-review-model: internal error — no spawn site for '${lens}'`);
    return 2;
  }

  if (json) {
    stdout(JSON.stringify({ lens, model: row.model, source: row.source }));
    return 0;
  }

  if (row.model) stdout(row.model);
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
