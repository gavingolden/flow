/**
 * `flow doctor [--json]` — read-only health report for the local flow setup.
 * Exit 0 when nothing failed (warnings do not fail), 1 when any check
 * failed, 2 on a usage error. Never fixes anything: each problem prints the
 * command that does.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import {
  defaultDoctorDeps,
  doctorExitCode,
  renderDoctorText,
  runDoctor,
  type DoctorDeps,
  type DoctorProbe,
} from "./doctor";

export const DOCTOR_PROBES: DoctorProbe[] = [];

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
