/**
 * `flow epic grant <epic-slug> --autonomy high|off` — the owner's grant of
 * plan-approval autonomy to an epic's executive.
 *
 * `high` is refused (exit 2, nothing written) unless stdin is a TTY AND
 * `CLAUDECODE` is unset: a session cannot grant by accident or on a peer's
 * instruction. This is a guard, not a proof — a determined session could
 * unset the variable; flow-launched sessions are additionally denied the
 * command and grant-file writes (`EPIC_GRANT_DENY_RULES`), and a forged grant
 * still shows on first use in the PR stamp and the log. `off` always works.
 */

import * as path from "node:path";
import type { EpicOptions } from "./epic";
import { epicDirRelative } from "./epic-manifest-schema";
import { readCommittedStatus } from "./epic-status-schema";
import { appendManagerLog, readManagerLog } from "./epic-manager-log";
import {
  loadManifestFromRepo,
  readGrant,
  removeGrant,
  writeGrant,
} from "./epic-grant";
import { readCharter } from "./exec-charter";
import { argsContainHelp } from "./help";
import { isValidSlug } from "./slug";
import { resolveRepoRoot } from "./repo-root";

const USAGE = "usage: flow epic grant <epic-slug> --autonomy high|off";

export type EpicGrantDeps = {
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  resolveRepo?: (cwd: string) => string | null;
};

export function runEpicGrant(
  args: string[],
  options: EpicOptions,
  deps: EpicGrantDeps = {},
): number {
  if (argsContainHelp(args)) {
    console.log(`flow epic grant — let an epic's executive approve plans for you

${USAGE}

  --autonomy high   write the grant (plain terminal only, never inside a Claude session)
  --autonomy off    withdraw the grant (allowed from anywhere)`);
    return 0;
  }

  let autonomy: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--autonomy") {
      autonomy = args[++i];
    } else if (a.startsWith("--autonomy=")) {
      console.error(
        "flow epic grant: use '--autonomy high|off' (space-separated), not the '=' form.",
      );
      console.error(USAGE);
      return 2;
    } else if (a.startsWith("-")) {
      console.error(`flow epic grant: unknown option '${a}'.`);
      console.error(USAGE);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1 || !isValidSlug(positionals[0])) {
    console.error(
      "flow epic grant: exactly one valid <epic-slug> is required.",
    );
    console.error(USAGE);
    return 2;
  }
  if (autonomy !== "high" && autonomy !== "off") {
    console.error("flow epic grant: --autonomy requires 'high' or 'off'.");
    console.error(USAGE);
    return 2;
  }
  const epic = positionals[0];
  const now = (deps.now ?? (() => new Date()))().toISOString();

  if (autonomy === "off") {
    const removed = removeGrant(epic, options.stateDir);
    appendManagerLog(
      epic,
      {
        ts: now,
        kind: "grant-withdrawn",
        reason: removed ? "owner-cli" : "no-grant-present",
      },
      options.stateDir,
    );
    console.log(
      removed
        ? `Withdrew the executive grant for epic '${epic}'. Plans pause for your approval again.`
        : `No grant was active for epic '${epic}'. Nothing changed.`,
    );
    return 0;
  }

  const env = deps.env ?? process.env;
  const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY || env.CLAUDECODE) {
    console.error(
      "flow epic grant: run this in a plain terminal outside any Claude session — a grant must come from your own keystroke. Nothing was written.",
    );
    return 2;
  }

  const cwd = options.cwd ?? process.cwd();
  const repo = (deps.resolveRepo ?? resolveRepoRoot)(cwd);
  if (!repo) {
    console.error(`flow epic grant: ${cwd} is not inside a git repository.`);
    return 2;
  }
  if (!loadManifestFromRepo(epic, repo)) {
    console.error(
      `flow epic grant: no valid manifest for epic '${epic}' under ${repo}/${epicDirRelative(epic)} — merge the design PR first.`,
    );
    return 2;
  }

  // A re-grant keeps the EARLIEST baseline so merges that landed while the
  // grant was withdrawn are still reviewed.
  const prior = readManagerLog(epic, options.stateDir).find(
    (e) => e.kind === "grant" && e.exec?.baselineMerged,
  );
  const board = readCommittedStatus(path.join(repo, epicDirRelative(epic)));
  const baselineMerged =
    prior?.exec?.baselineMerged ??
    Object.entries(board?.features ?? {})
      .filter(([, row]) => row.status === "merged")
      .map(([id]) => id)
      .sort();

  const hadGrant = readGrant(epic, options.stateDir) !== null;
  writeGrant(
    {
      version: 1,
      epic,
      classes: ["plan"],
      grantedAt: now,
      grantedBy: "owner-cli",
    },
    options.stateDir,
  );
  appendManagerLog(
    epic,
    {
      ts: now,
      kind: "grant",
      reason: "owner-cli",
      exec: { decisionId: `grant-${now}`, reviewKind: "plan", baselineMerged },
    },
    options.stateDir,
  );
  console.log(
    `${hadGrant ? "Refreshed" : "Granted"} plan-approval autonomy for epic '${epic}'.`,
  );
  console.log(
    "  The epic executive may now approve this epic's plans when it is highly confident and the call is reversible; every decision is logged and stamped in the PR.",
  );
  console.log(
    "  Cost: a wrong call can let a plan through without you reading it; you will only see it afterward, in the PR stamp and the log.",
  );
  if (!readCharter().found) {
    console.log(
      "  Warning: ~/.flow/product.md has no usable '## Deciding on my behalf' section, so every plan on this epic will still pause for you until you add one.",
    );
  }
  console.log(`  Withdraw any time: flow epic grant ${epic} --autonomy off`);
  return 0;
}
