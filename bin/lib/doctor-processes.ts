/**
 * `flow doctor` process checks: registry rows left by dead pipelines and
 * shape-matched strays. Report-only (`yes: false`) — never signals; counts and
 * slugs only, never a process argv.
 */

import type { DoctorCheck, DoctorDeps } from "./doctor";
import { collectReapReport } from "./reap-cli";

const SECTION = "leftovers" as const;
const REAP_DEADLINE_MS = 5000;

export function checkLeakedProcesses(
  deps: DoctorDeps,
  collect: typeof collectReapReport = collectReapReport,
): DoctorCheck[] {
  const report = collect({
    yes: false,
    baseDir: deps.reapBaseDir,
    deadlineMs: REAP_DEADLINE_MS,
  });
  const dead = report.registry.slugs.filter((s) => s.reported.dead > 0);
  const deadCount = dead.reduce((n, s) => n + s.reported.dead, 0);
  const timedOut = report.registry.slugs.filter(
    (s) => s.skipped === "deadline-exceeded",
  );
  const checks: DoctorCheck[] = [];
  if (deadCount > 0) {
    checks.push({
      id: "leftovers-processes",
      section: SECTION,
      title: "Leaked processes",
      status: "warn",
      summary: `${deadCount} process(es) left by dead pipelines`,
      details: [
        `pipelines: ${dead.map((s) => s.slug).join(", ")}`,
        "flow reap --yes signals only rows whose identity it re-verifies",
      ],
      fix: "flow reap --yes",
    });
  } else if (timedOut.length > 0) {
    checks.push({
      id: "leftovers-processes",
      section: SECTION,
      title: "Leaked processes",
      status: "warn",
      summary: `${timedOut.length} pipeline(s) not checked before the sweep deadline`,
      details: [`pipelines: ${timedOut.map((s) => s.slug).join(", ")}`],
      fix: "flow reap",
    });
  } else {
    checks.push({
      id: "leftovers-processes",
      section: SECTION,
      title: "Leaked processes",
      status: "pass",
      summary: "no processes left by dead pipelines",
      details: [],
    });
  }
  const h = report.heuristic;
  if (h.skipReason === "ps-unavailable") {
    checks.push({
      id: "leftovers-strays",
      section: SECTION,
      title: "Stray browsers and servers",
      status: "skip",
      summary: "ps is unavailable, so strays were not scanned",
      details: [],
    });
  } else if (h.found.length + h.foundServers.length > 0) {
    checks.push({
      id: "leftovers-strays",
      section: SECTION,
      title: "Stray browsers and servers",
      status: "warn",
      summary: `${h.found.length} browser(s) and ${h.foundServers.length} MCP server(s) look orphaned`,
      details: [
        "matched by shape, not identity; the sweep signals them host-wide",
      ],
      fix: "flow reap --yes --include-strays (host-wide)",
    });
  } else {
    checks.push({
      id: "leftovers-strays",
      section: SECTION,
      title: "Stray browsers and servers",
      status: "pass",
      summary: "no orphaned browsers or MCP servers",
      details: [],
    });
  }
  return checks;
}
