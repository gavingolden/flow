#!/usr/bin/env bun
/**
 * One-call NEEDS HUMAN escalation for the epic-design supervisor
 * (`/flow-epic-create`). Records the pause, arms the terminal checkpoint, and
 * prints the pause block — so a `/clear` (or a crash and
 * `flow epic create --resume`) at the escalation continues instead of dying,
 * and no half-done escalation (phase written, checkpoint never armed) is
 * possible from a skipped prose step.
 *
 * Why not `flow-gate-summary --status needs-human`: its phase write goes
 * through `finalizePhase`, which refuses to finalize from an epic phase by
 * design (`bin/lib/phase-advance.ts`), so it would neither record the pause
 * nor arm the checkpoint for an epic.
 *
 * Usage:
 *   flow-epic-escalate --reason <tag> [--why <line>] [--slug <slug>]
 *
 * `<slug>` defaults to `$FLOW_SLUG`. Writes phase `needs-human` through
 * `flow-state-update`'s `runUpdate` (so `phaseLog` keeps the paused phase and
 * the pane-read / write-site parity lints hold), writes a "Paused at phase"
 * note when the terminal-site freshness probe says `write`, arms
 * `--site terminal` (one `checkpointed: …` stderr line — echo it verbatim),
 * and prints the pause block on stdout ending in the byte-exact
 * `NEEDS HUMAN: <reason>` sentinel. An already-`needs-human` state (a
 * resume-mode escalation) skips the phase write and still re-arms + prints.
 *
 * Exit codes: 0 — pause recorded and block printed (an arm failure is
 * reported on stderr as `checkpointed: false` but never changes the exit);
 * 2 — bad args, no slug, missing state, a refused state, or a failed phase
 * write (state left unchanged, nothing armed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { armCheckpoint, renderArmBanner } from "./flow-checkpoint";
import { runUpdate } from "./flow-state-update";
import { checkpointBodyPath, probeFreshness } from "./lib/checkpoint-freshness";
import { FLOW_STATE_DIR } from "./lib/paths";
import { recoveryCommandFor } from "./lib/recovery-command";
import { resolveSlugAmbient } from "./lib/session-identity";
import {
  isEpicPhase,
  nowIso,
  pausedPhase,
  readState,
  resolveStateKind,
  TERMINAL_PHASE_SET,
} from "./lib/state";

const USAGE =
  "usage: flow-epic-escalate --reason <tag> [--why <line>] [--slug <slug>]";

export type Deps = {
  stateDir?: string;
  resolveSlug?: () => string | null;
};

type Parsed = { reason: string; why: string; slug?: string };

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

export function parseArgs(argv: string[]): Parsed | { error: string } {
  const out = { reason: "", why: "", slug: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--reason" && flag !== "--why" && flag !== "--slug") {
      return { error: `unknown argument: ${flag}` };
    }
    const value = argv[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    if (flag === "--reason") out.reason = oneLine(value);
    else if (flag === "--why") out.why = oneLine(value);
    else out.slug = value;
  }
  if (!out.reason) return { error: "--reason <tag> is required" };
  return out;
}

export function run(argv: string[], deps: Deps = {}): number {
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-epic-escalate: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const slug = parsed.slug ?? (deps.resolveSlug ?? resolveSlugAmbient)();
  if (!slug) {
    console.error(
      "flow-epic-escalate: no slug given and no FLOW_SLUG in the environment.",
    );
    return 2;
  }
  const state = readState(slug, stateDir);
  if (!state) {
    console.error(`flow-epic-escalate: no state file for slug '${slug}'.`);
    return 2;
  }
  const escalatable =
    state.phase === "starting" ||
    state.phase === "needs-human" ||
    (isEpicPhase(state.phase) && !TERMINAL_PHASE_SET.has(state.phase));
  if (resolveStateKind(state) === "feature" || !escalatable) {
    console.error(
      `flow-epic-escalate: refusing — '${slug}' is not an epic-design pipeline at a live epic phase (phase '${state.phase}'); state unchanged.`,
    );
    return 2;
  }

  if (state.phase !== "needs-human") {
    const code = runUpdate([slug, "--phase", "needs-human"], stateDir);
    if (code !== 0) {
      console.error(
        `flow-epic-escalate: could not record the needs-human phase (flow-state-update exit ${code}); nothing armed.`,
      );
      return 2;
    }
  }

  try {
    const paused = readState(slug, stateDir);
    if (
      paused &&
      probeFreshness(paused, "terminal", stateDir).verdict === "write"
    ) {
      const at = pausedPhase(paused.phaseLog) ?? "unknown";
      const body =
        [
          `Epic design escalated to NEEDS HUMAN (${parsed.reason}) at ${nowIso()}.`,
          `Why: ${parsed.why || parsed.reason}`,
          `Paused at phase: ${at} — ${parsed.reason}`,
        ].join("\n") + "\n";
      const bodyPath = checkpointBodyPath(slug, stateDir);
      fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
      fs.writeFileSync(bodyPath, body);
    }
    process.stderr.write(
      armCheckpoint(slug, "terminal", stateDir).banner + "\n",
    );
  } catch (err) {
    process.stderr.write(
      renderArmBanner({
        armed: false,
        reason: `arm-failed: ${String(err).replace(/\n/g, " ").slice(0, 200)}`,
      }) + "\n",
    );
  }

  process.stdout.write(
    [
      "STATUS: NEEDS HUMAN",
      `WHY: ${parsed.why || parsed.reason}`,
      `NEXT ACTION: reply done here once resolved (a /clear first is fine), or run ${recoveryCommandFor(slug, "epic-design")}`,
      `NEEDS HUMAN: ${parsed.reason}`,
    ].join("\n") + "\n",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
