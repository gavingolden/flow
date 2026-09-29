/**
 * `flow doctor [--json]` — read-only health report for the local flow setup.
 * Exit 0 when nothing failed (warnings do not fail), 1 when any check
 * failed, 2 on a usage error. Never fixes anything: each problem prints the
 * command that does.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { checkPipelineState, PIPELINE_RECORDS_META } from "./doctor-pipelines";
import {
  checkLeakedProcesses,
  LEAKED_PROCESSES_META,
} from "./doctor-processes";
import { checkStaleWorktrees, STALE_WORKTREES_META } from "./doctor-resources";
import {
  checkAgy,
  checkClaude,
  checkGh,
  checkTmux,
  TOOLS_AGY_META,
  TOOLS_CLAUDE_META,
  TOOLS_GH_META,
  TOOLS_TMUX_META,
} from "./doctor-tools";
import {
  checkBinDirOnPath,
  checkFlowSlug,
  SHELL_FLOW_SLUG_META,
  SHELL_PATH_META,
} from "./doctor-env";
import {
  checkInstalledModules,
  checkInstallLinks,
  checkRuntimePackages,
  INSTALL_LINKS_META,
  INSTALL_MODULES_META,
  INSTALL_PACKAGES_META,
} from "./doctor-install";
import {
  defaultDoctorDeps,
  doctorExitCode,
  guarded,
  runDoctor,
  type DoctorDeps,
  type DoctorProbe,
} from "./doctor";
import { renderDoctorText } from "./doctor-render";

export const DOCTOR_PROBES: DoctorProbe[] = [
  guarded(INSTALL_LINKS_META, (deps) => checkInstallLinks(deps)),
  guarded(INSTALL_MODULES_META, (deps) => checkInstalledModules(deps)),
  guarded(INSTALL_PACKAGES_META, (deps) => checkRuntimePackages(deps)),
  guarded(SHELL_FLOW_SLUG_META, (deps) => checkFlowSlug(deps)),
  guarded(SHELL_PATH_META, (deps) => checkBinDirOnPath(deps)),
  guarded(TOOLS_GH_META, (deps) => checkGh(deps)),
  guarded(TOOLS_TMUX_META, (deps) => checkTmux(deps)),
  guarded(TOOLS_CLAUDE_META, (deps) => checkClaude(deps)),
  guarded(TOOLS_AGY_META, (deps) => checkAgy(deps)),
  guarded(STALE_WORKTREES_META, (deps) => checkStaleWorktrees(deps)),
  guarded(PIPELINE_RECORDS_META, (deps) => checkPipelineState(deps)),
  guarded(LEAKED_PROCESSES_META, (deps) => checkLeakedProcesses(deps)),
];

export async function runDoctorCli(
  args: string[],
  overrides: { deps?: Partial<DoctorDeps>; probes?: DoctorProbe[] } = {},
): Promise<number> {
  if (argsContainHelp(args)) {
    printVerbHelp("doctor");
    return 0;
  }
  let json = false;
  for (const a of args) {
    if (a === "--json") {
      json = true;
    } else {
      console.error(`flow doctor: unknown flag: ${a}`);
      console.error("usage: flow doctor [--json]");
      return 2;
    }
  }

  const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides.deps };
  const report = await runDoctor(overrides.probes ?? DOCTOR_PROBES, deps);
  console.log(json ? JSON.stringify(report) : renderDoctorText(report));
  return doctorExitCode(report);
}
