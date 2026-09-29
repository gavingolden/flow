/**
 * `flow doctor [--json]` — read-only health report for the local flow setup.
 * Exit 0 when nothing failed (warnings do not fail), 1 when any check
 * failed, 2 on a usage error. Never fixes anything: each problem prints the
 * command that does.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import { checkBinDirOnPath, checkFlowSlug } from "./doctor-env";
import {
  checkInstalledModules,
  checkInstallLinks,
  checkRuntimePackages,
} from "./doctor-install";
import {
  defaultDoctorDeps,
  doctorExitCode,
  guarded,
  renderDoctorText,
  runDoctor,
  type DoctorDeps,
  type DoctorProbe,
} from "./doctor";

export const DOCTOR_PROBES: DoctorProbe[] = [
  guarded(
    { id: "install-links", section: "install", title: "Installed links" },
    (deps) => checkInstallLinks(deps),
  ),
  guarded(
    { id: "install-modules", section: "install", title: "Installed modules" },
    (deps) => checkInstalledModules(deps),
  ),
  guarded(
    { id: "install-packages", section: "install", title: "Runtime packages" },
    (deps) => checkRuntimePackages(deps),
  ),
  guarded(
    {
      id: "shell-flow-slug",
      section: "shell",
      title: "Shell pipeline identity",
    },
    (deps) => checkFlowSlug(deps),
  ),
  guarded({ id: "shell-path", section: "shell", title: "PATH" }, (deps) =>
    checkBinDirOnPath(deps),
  ),
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
