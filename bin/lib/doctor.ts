/**
 * `flow doctor` core: the check model, the aggregator and the injectable deps
 * every probe reads. Probes are READ-ONLY by contract — they never write
 * state, never signal a process, and reach every subprocess through
 * `deps.run` so tests can fake the host. Every path a probe touches comes from
 * `deps`, never from a `paths.ts` default (those freeze HOME at import time).
 */

import { spawnSync } from "node:child_process";
import * as os from "node:os";
import {
  FLOW_MANIFEST,
  FLOW_STATE_DIR,
  flowConfigPath,
  resolveFlowSource,
  configuredFlowSource,
} from "./paths";
import { DEFAULT_TARGETS, type InstallTargets } from "./sources";
import { inspectFlowRoot } from "./worktree-source";

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";
export type DoctorSection = "install" | "shell" | "tools" | "leftovers";

export type DoctorCheck = {
  id: string;
  section: DoctorSection;
  title: string;
  status: DoctorStatus;
  summary: string;
  details: string[];
  fix?: string;
};

export type DoctorReport = {
  version: 1;
  ok: boolean;
  counts: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
};

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
  timedOut: boolean;
};

export type DoctorDeps = {
  env: NodeJS.ProcessEnv;
  run: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ) => RunResult;
  homeDir: string;
  cwd: string;
  stateDir: string;
  manifestPath: string;
  configPath: string;
  targets: InstallTargets;
  flowSource: string;
  installRoot: string;
  nowMs: () => number;
  reapBaseDir?: string;
  platform?: NodeJS.Platform;
};

export type DoctorProbe = (
  deps: DoctorDeps,
) => DoctorCheck[] | Promise<DoctorCheck[]>;

const DEFAULT_RUN_TIMEOUT_MS = 5000;

function defaultRun(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): RunResult {
  // node:child_process, not Bun.spawnSync: probes also run under vitest's Node.
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    notFound: code === "ENOENT",
    timedOut: code === "ETIMEDOUT" || (r.status === null && r.signal !== null),
  };
}

/** Mirrors the installer's worktree-repoint rule: a worktree flow source
 * installs against its canonical checkout unless `config.source` pins one. */
export function resolveInstallRoot(
  flowSource: string,
  homeDir: string,
  io: {
    inspect?: typeof inspectFlowRoot;
    configured?: (homeDir: string) => string | null;
  } = {},
): string {
  const info = (io.inspect ?? inspectFlowRoot)(flowSource);
  if (
    info.isWorktree &&
    info.canonicalRoot &&
    (io.configured ?? configuredFlowSource)(homeDir) === null
  ) {
    return info.canonicalRoot;
  }
  return flowSource;
}

export function defaultDoctorDeps(): DoctorDeps {
  const homeDir = os.homedir();
  const flowSource = resolveFlowSource(homeDir);
  return {
    env: process.env,
    run: defaultRun,
    homeDir,
    cwd: process.cwd(),
    stateDir: FLOW_STATE_DIR,
    manifestPath: FLOW_MANIFEST,
    configPath: flowConfigPath(),
    targets: DEFAULT_TARGETS,
    flowSource,
    installRoot: resolveInstallRoot(flowSource, homeDir),
    nowMs: () => Date.now(),
    platform: process.platform,
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function couldNotRun(
  meta: { id: string; section: DoctorSection; title: string },
  err: unknown,
): DoctorCheck {
  return {
    ...meta,
    status: "warn",
    summary: `could not run: ${reasonOf(err)}`,
    details: [
      "this check did not finish; re-run flow doctor, and if it keeps failing run the failing tool by hand",
    ],
  };
}

/** Wraps a probe so a throw becomes one `could not run` warn carrying the
 * probe's own id/section instead of aborting the whole report. */
export function guarded(
  meta: { id: string; section: DoctorSection; title: string },
  fn: DoctorProbe,
): DoctorProbe {
  return async (deps) => {
    try {
      return await fn(deps);
    } catch (err) {
      return [couldNotRun(meta, err)];
    }
  };
}

export async function runDoctor(
  probes: DoctorProbe[],
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  for (const [i, probe] of probes.entries()) {
    try {
      checks.push(...(await probe(deps)));
    } catch (err) {
      checks.push(
        couldNotRun(
          { id: `probe-${i + 1}`, section: "tools", title: "doctor probe" },
          err,
        ),
      );
    }
  }
  const counts: Record<DoctorStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
  };
  for (const c of checks) counts[c.status] += 1;
  return { version: 1, ok: counts.fail === 0, counts, checks };
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.counts.fail > 0 ? 1 : 0;
}
