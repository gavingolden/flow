/**
 * Argument parsing + CLI wrapper for `flow install`. Kept separate from
 * `bin/lib/setup.ts` so the CLI seam is unit-testable without enlarging
 * the library file (already over the < 200-line target).
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { resolveFlowSource } from "./paths";
import { runSetup, type SetupOptions } from "./setup";
import { MANDATORY_MODULE, isKnownModule } from "./modules";

export type ParsedSetupArgs = {
  upgrade: boolean;
  force: boolean;
  noCompletions: boolean;
  noHooks: boolean;
  pullCanonical: boolean;
  repairSettings: boolean;
  installDeps: boolean;
  flowSource?: string;
  /** Resolved module selection from `--modules <csv>` or `--core-only` (sugar for `--modules core`). `undefined` when neither flag was passed. */
  modules?: string[];
  /** `--all`: select every module. Mutually exclusive with `modules`/`coreOnly`. */
  all?: boolean;
  /** True when `--core-only` was passed (informational — `modules` already carries `["core"]`). */
  coreOnly?: boolean;
};

export type SetupArgsResult = ParsedSetupArgs | { error: string };

const USAGE =
  "usage: flow install [--upgrade] [--force] [--source <path>] [--no-completions] [--no-hooks] [--no-pull-canonical] [--repair-settings] [--install-deps] [--modules <csv>|--all|--core-only]";
const FLAGS = new Set([
  "--upgrade",
  "--force",
  "--no-completions",
  "--no-hooks",
  "--no-pull-canonical",
  "--repair-settings",
  "--install-deps",
  "--all",
  "--core-only",
]);

export function parseSetupArgs(args: string[]): SetupArgsResult {
  const out: ParsedSetupArgs = {
    upgrade: false,
    force: false,
    noCompletions: false,
    noHooks: false,
    pullCanonical: true,
    repairSettings: false,
    installDeps: false,
  };
  let sawModules = false;
  let sawAll = false;
  let sawCoreOnly = false;
  let modulesRaw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--upgrade") {
      out.upgrade = true;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--no-completions") {
      out.noCompletions = true;
    } else if (arg === "--no-hooks") {
      out.noHooks = true;
    } else if (arg === "--no-pull-canonical") {
      out.pullCanonical = false;
    } else if (arg === "--repair-settings") {
      out.repairSettings = true;
    } else if (arg === "--install-deps") {
      out.installDeps = true;
    } else if (arg === "--all") {
      sawAll = true;
    } else if (arg === "--core-only") {
      sawCoreOnly = true;
    } else if (arg === "--modules") {
      const value = args[i + 1];
      if (!value || FLAGS.has(value) || value === "--modules") {
        return {
          error:
            "flow install: --modules requires a comma-separated list of module ids",
        };
      }
      sawModules = true;
      modulesRaw = value;
      i++;
    } else if (arg === "--source") {
      const value = args[i + 1];
      if (!value || FLAGS.has(value) || value === "--source") {
        return { error: "flow install: --source requires a path argument" };
      }
      out.flowSource = value;
      i++;
    } else {
      return { error: `flow install: unknown option '${arg}'` };
    }
  }
  // --no-hooks opts out of touching settings.json this run; --repair-settings
  // is a settings.json recovery mode. The combination would silently no-op on
  // the repair branch (no-hooks skips the entire merge), so reject it at the
  // CLI seam where the user can still react.
  if (out.noHooks && out.repairSettings) {
    return {
      error:
        "flow install: --no-hooks and --repair-settings are mutually exclusive",
    };
  }
  // --modules / --all / --core-only select the same thing three ways; any
  // two together is an ambiguous request, so reject before touching any
  // symlink (mirrors the --no-hooks/--repair-settings guard above).
  if ([sawModules, sawAll, sawCoreOnly].filter(Boolean).length > 1) {
    return {
      error:
        "flow install: --modules, --all, and --core-only are mutually exclusive",
    };
  }
  if (sawCoreOnly) {
    out.coreOnly = true;
    out.modules = [MANDATORY_MODULE];
  } else if (sawAll) {
    out.all = true;
  } else if (sawModules) {
    const ids = modulesRaw!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const unknown = ids.find((id) => !isKnownModule(id));
    if (unknown) {
      return { error: `flow install: unknown module id '${unknown}'` };
    }
    out.modules = ids;
  }
  return out;
}

/**
 * CLI wrapper for `bin/flow`'s install verb. Parses args, delegates to
 * `runSetup`, and translates the resulting `SetupSummary` to a process
 * exit code: blocked symlinks → 1, parser errors → 2, otherwise 0.
 *
 * `extraOptions` is a test-only escape hatch for the same internal
 * overrides that `runSetup` itself accepts (`targets`, `manifestPath`,
 * `lockPath`, `skipPreflight`, `quiet`, …). It also lets a test pass
 * `flowSource` without going through `--source` parsing — handy when the
 * fake source path includes characters that aren't worth round-tripping
 * through arg parsing.
 */
export async function runSetupCli(
  args: string[],
  extraOptions?: SetupOptions,
): Promise<number> {
  if (argsContainHelp(args)) {
    printVerbHelp("install");
    return 0;
  }
  const parsed = parseSetupArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  // Pin installRoot to canonical at the CLI seam when --source is in play.
  // Without this, runSetup's internal fallback through resolveFlowSource()
  // would re-derive installRoot after the wrapper symlink was already
  // poisoned by a prior --source run, collapsing it onto the worktree and
  // stranding the manifest on the next worktree removal.
  // coreOnly is discarded here — it's fully resolved into `modules: ["core"]`
  // at parse time and setup.ts has no use for the raw flag.
  const { pullCanonical, coreOnly: _coreOnly, ...rest } = parsed;
  const opts: SetupOptions = {
    ...rest,
    pullCanonicalFirst: pullCanonical,
    ...extraOptions,
  };
  if (parsed.flowSource !== undefined && opts.installRoot === undefined) {
    opts.installRoot = resolveFlowSource(opts.homeDir);
  }
  const summary = await runSetup(opts);
  return summary.blocked > 0 ||
    summary.validationFailures.length > 0 ||
    summary.missingRuntimeDeps.length > 0
    ? 1
    : 0;
}
