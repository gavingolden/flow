#!/usr/bin/env bun
/**
 * Runtime per-spawn effort resolver for the Task-spawn sites. Sibling of
 * `flow-review-model`: that one answers "which model", this one answers
 * "which `effort:` argument". It calls `resolveSpawnEffort`
 * (`bin/lib/model-routing-table.ts`) directly, so there is exactly one
 * precedence implementation shared with the `flow config models` audit.
 *
 * Usage:
 *   flow-spawn-effort <phase> [--slug <slug>] [--config <path>] [--state <path>] [--json]
 *
 * Prints the resolved effort level (one of low|medium|high|xhigh|max) on
 * stdout and exits 0. Prints NOTHING (still exits 0) when the spawn should
 * omit `effort:` — the role follows the session, or the running Claude Code
 * build cannot take a per-spawn `effort` (needs 2.1.292+, or undetectable).
 * The spawn site passes `effort:` iff the output is non-empty and carries no
 * version logic of its own. `--json` prints `{"phase","effort","source","build"}`
 * (`effort` is `""` for the omit case) for the audit path.
 *
 * `<phase>` is any `SPAWN_SITES` phase except `session` (no spawn) and the
 * bare `review` row (a group grain; use `review-lens:<lens>`).
 *
 * Session effort for the `≤ session` ceiling: `$CLAUDE_EFFORT`, else the
 * pipeline's `state.effort` (`--slug`, else `$FLOW_SLUG`), else unknown.
 *
 * Exit codes: 0 resolved (incl. omit), 2 bad args / unknown or unsupported phase.
 */

import { fileReader, fileStateLoader } from "./flow-review-model";
import {
  detectClaudeBuild,
  MIN_SUBAGENT_EFFORT_VERSION,
  readSessionEffort,
  supportsSubagentEffort,
} from "./lib/claude-build";
import { readEffortsConfig } from "./lib/efforts-config";
import {
  cachedConfigRead,
  defaultReadConfigFile,
  type ReadConfigFile,
} from "./lib/models-config";
import { resolveSpawnEffort, SPAWN_SITES } from "./lib/model-routing-table";
import { resolveSlugAmbient } from "./lib/session-identity";
import { readState, type PipelineState } from "./lib/state";

export { detectClaudeBuild, MIN_SUBAGENT_EFFORT_VERSION };

const PHASES = SPAWN_SITES.map((s) => s.phase).filter(
  (p) => p !== "session" && p !== "review",
);

const USAGE =
  "usage: flow-spawn-effort <phase> [--slug <slug>] [--config <path>] [--state <path>] [--json]\n" +
  `  <phase> must be one of: ${PHASES.join(", ")}`;

export type FlowSpawnEffortDeps = {
  /** Injectable config reader (test seam); defaults to the real `~/.flow/config.json` read. */
  read?: ReadConfigFile;
  /** Injectable environment (test seam); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable slug->state reader (test seam); defaults to `readState`. */
  loadState?: (slug: string) => PipelineState | null;
  /** Injectable ambient-slug resolver (test seam); defaults to `resolveSlugAmbient`. */
  resolveSlug?: () => string | null;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
};

export function run(argv: string[], deps: FlowSpawnEffortDeps = {}): number {
  const stdout = deps.stdout ?? ((s: string) => console.log(s));
  const stderr = deps.stderr ?? ((s: string) => console.error(s));
  const env = deps.env ?? process.env;

  let slug: string | undefined;
  let configPath: string | undefined;
  let statePath: string | undefined;
  let json = false;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--slug" || arg === "--config" || arg === "--state") {
      const value = argv[++i];
      if (value === undefined) {
        stderr(`flow-spawn-effort: ${arg} requires a value`);
        return 2;
      }
      if (arg === "--slug") slug = value;
      else if (arg === "--config") configPath = value;
      else statePath = value;
    } else if (arg === "--help" || arg === "-h") {
      stdout(USAGE);
      return 0;
    } else if (arg.startsWith("--")) {
      stderr(`flow-spawn-effort: unknown option '${arg}'`);
      stderr(USAGE);
      return 2;
    } else {
      positionals.push(arg);
    }
  }

  const phase = positionals[0];
  if (phase === "session") {
    stderr("flow-spawn-effort: 'session' is not a spawn site");
    return 2;
  }
  if (phase === "review") {
    stderr(
      "flow-spawn-effort: 'review' is a group grain with no per-spawn effort — use review-lens:<lens>",
    );
    return 2;
  }
  const site = SPAWN_SITES.find((s) => s.phase === phase);
  if (!phase || !site) {
    stderr(
      `flow-spawn-effort: unknown phase '${phase ?? ""}' — expected one of: ${PHASES.join(", ")}`,
    );
    return 2;
  }

  const build = detectClaudeBuild(env);
  const emit = (effort: string, source: string) => {
    if (json) stdout(JSON.stringify({ phase, effort, source, build }));
    else if (effort) stdout(effort);
    return 0;
  };

  if (!supportsSubagentEffort(env)) {
    return emit(
      "",
      `per-spawn effort needs Claude Code ${MIN_SUBAGENT_EFFORT_VERSION}+ (build: ${build ?? "undetectable"})`,
    );
  }

  const read: ReadConfigFile = cachedConfigRead(
    deps.read ?? (configPath ? fileReader(configPath) : defaultReadConfigFile),
  );
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

  const { effort, source } = resolveSpawnEffort(
    site,
    readEffortsConfig(read),
    readSessionEffort(env, state),
  );
  return emit(effort, source);
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
