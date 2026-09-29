/**
 * `flow doctor` process checks: processes still running after their pipeline
 * ended, and shape-matched strays. Report-only (`yes: false`) — never signals; counts and
 * slugs only, never a process argv.
 */

import type { DoctorCheck, DoctorDeps } from "./doctor";
import { capped } from "./doctor-util";
import type { ReapOutcome } from "./reap";
import { collectReapReport } from "./reap-cli";

const SECTION = "leftovers" as const;
export const LEAKED_PROCESSES_META = {
  id: "leftovers-processes",
  section: SECTION,
  title: "Leaked processes",
} as const;
const REAP_DEADLINE_MS = 5000;
// Outcomes of the report-only sweep. `already-dead` rows are stale registry
// entries, and `skipped-epoch-mismatch` is a reused pid owned by an unrelated
// process: neither is a leak. `skipped-unsafe-pgid` and
// `skipped-foreign-member` are refusals `flow reap --yes` would repeat, so
// flagging them would print a fix that does nothing; they are deliberately
// left out. `deadline-exceeded` rows were never checked, so they are counted
// as unchecked, never as clean.
const RUNNING: readonly ReapOutcome[] = ["would-reap"];
const NEEDS_LOOK: readonly ReapOutcome[] = [
  "skipped-dead-leader",
  "still-alive",
  "failed",
];
const STALE: readonly ReapOutcome[] = ["already-dead"];

export function checkLeakedProcesses(
  deps: DoctorDeps,
  collect: typeof collectReapReport = collectReapReport,
): DoctorCheck[] {
  const report = collect({
    yes: false,
    baseDir: deps.reapBaseDir,
    stateDir: deps.stateDir,
    deadlineMs: REAP_DEADLINE_MS,
  });
  const slugs = report.registry.slugs;
  const sum = (s: (typeof slugs)[number], keys: readonly ReapOutcome[]) =>
    keys.reduce((n, k) => n + (s.reap?.counts?.[k] ?? 0), 0);
  const total = (keys: readonly ReapOutcome[]) =>
    slugs.reduce((n, s) => n + sum(s, keys), 0);
  const running = total(RUNNING);
  const needLook = total(NEEDS_LOOK);
  const stale = total(STALE);
  const flagged = slugs.filter((s) => sum(s, RUNNING) + sum(s, NEEDS_LOOK) > 0);
  const timedOut = slugs.filter(
    (s) =>
      s.skipped === "deadline-exceeded" || sum(s, ["deadline-exceeded"]) > 0,
  );
  const staleLine =
    stale > 0
      ? [
          `${stale} stale registry ${stale === 1 ? "entry" : "entries"} for processes that already exited; flow reap --yes clears them`,
        ]
      : [];
  const checks: DoctorCheck[] = [];
  if (running > 0 || needLook > 0) {
    const parts = [
      ...(running > 0
        ? [`${running} process(es) still running from ended pipelines`]
        : []),
      ...(needLook > 0
        ? [
            `${needLook} process(es) from ended pipelines need a look (leader gone, still alive, or failed to signal)`,
          ]
        : []),
    ];
    checks.push({
      ...LEAKED_PROCESSES_META,
      status: "warn",
      summary: parts.join("; "),
      details: [
        `pipelines: ${capped(flagged.map((s) => s.slug)).join(", ")}`,
        "flow reap --yes signals only rows whose identity it re-verifies",
        ...staleLine,
      ],
      fix: running > 0 ? "flow reap --yes" : "flow reap",
    });
  } else if (timedOut.length > 0) {
    checks.push({
      ...LEAKED_PROCESSES_META,
      status: "warn",
      summary: `${timedOut.length} pipeline(s) not checked before the sweep deadline`,
      details: [`pipelines: ${capped(timedOut.map((s) => s.slug)).join(", ")}`],
      fix: "flow reap",
    });
  } else {
    checks.push({
      ...LEAKED_PROCESSES_META,
      status: "pass",
      summary: "no processes left running by ended pipelines",
      details: staleLine,
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
      fix: "flow reap --yes --include-strays",
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
