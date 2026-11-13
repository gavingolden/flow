/**
 * `flow grant <scope> --autonomy high|off [--delegate-ui] [--expires <n>h|d|w]`,
 * `flow grant <scope> --relay [--expires <n>h|d|w]` (the owner may answer a
 * paused pipeline from the manager window, with no executive autonomy) and
 * `flow grant --list` — the owner's grant of plan-approval autonomy to the
 * executive for one pipeline, epic or repo.
 *
 * `high` and `--relay` are refused (exit 2, nothing written) unless stdin is a TTY AND
 * `CLAUDECODE` is unset: a session cannot grant by accident or on a peer's
 * instruction. This is a guard, not a proof — a determined session could
 * unset the variable; flow-launched sessions are additionally denied the
 * command and grant-file writes (`GRANT_DENY_RULES`), and a forged grant
 * still shows on first use in the PR stamp and the log. `off` and `--list`
 * always work.
 */

import * as path from "node:path";
import { epicDirRelative } from "./epic-manifest-schema";
import { readCommittedStatus } from "./epic-status-schema";
import { readCharter } from "./exec-charter";
import { argsContainHelp, printVerbHelp } from "./help";
import {
  isLive,
  liveGrants,
  readGrants,
  removeGrant,
  upsertGrant,
  type GrantClass,
  type ScopedGrant,
} from "./manager-grants";
import { appendManagerLog, readManagerLog } from "./manager-log";
import {
  ALLOWED_SCOPE_KINDS,
  formatScope,
  parseScope,
  repoNameForPath,
  scopeMatches,
  specificity,
  type PipelineIdentity,
  type Scope,
} from "./manager-scope";
import { identitiesFor, resolveScopeTarget } from "./grant-target";
import { resolveRepoRoot } from "./repo-root";

const USAGE = `usage: flow grant <pipeline:<slug>|epic:<slug>|repo:<name>> --autonomy high|off [--delegate-ui] [--expires <n>h|d|w]
       flow grant <pipeline:<slug>|epic:<slug>|repo:<name>> --relay [--expires <n>h|d|w]
       flow grant --list`;

export type GrantCliDeps = {
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  cwd?: string;
  stateDir?: string;
  home?: string;
  resolveRepo?: (cwd: string) => string | null;
};

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

export function parseExpires(s: string): number | null {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n * UNIT_MS[m[2] as keyof typeof UNIT_MS] : null;
}

function fail(msg: string): number {
  console.error(`flow grant: ${msg}`);
  console.error(USAGE);
  return 2;
}

function describeGrant(g: ScopedGrant, live: boolean, now: Date): string {
  const allows = [
    ...(g.classes.includes("plan") ? ["approves plans"] : []),
    ...(g.classes.includes("relay") && !g.classes.includes("plan")
      ? ["relays your answers"]
      : []),
    ...(g.classes.includes("plan") && !g.scope.startsWith("pipeline:")
      ? ["reorders unstarted epic features"]
      : []),
    ...(g.classes.includes("subjective") ? ["judges UI steps"] : []),
  ].join(", ");
  const expiry = g.expiresAt ? Date.parse(g.expiresAt) : NaN;
  const when = !g.expiresAt
    ? "no expiry"
    : live
      ? `expires in ${relativeTime(expiry - now.getTime())}`
      : `expired ${relativeTime(now.getTime() - expiry)} ago`;
  return `${g.scope}  ${allows}  granted ${g.grantedAt.slice(0, 10)}  ${when}`;
}

function relativeTime(ms: number): string {
  const h = Math.max(0, Math.round(ms / 3_600_000));
  return h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
}

function runList(deps: GrantCliDeps): number {
  const now = (deps.now ?? (() => new Date()))();
  const all = readGrants(deps.home);
  const live = all.filter((g) => isLive(g, now));
  const expired = all.filter((g) => !isLive(g, now));
  if (live.length === 0) console.log("No live grants.");
  else {
    console.log("Live grants:");
    for (const g of live) console.log(`  ${describeGrant(g, true, now)}`);
  }
  if (expired.length > 0) {
    console.log("Expired:");
    for (const g of expired) console.log(`  ${describeGrant(g, false, now)}`);
  }
  return 0;
}

export function runGrantCli(args: string[], deps: GrantCliDeps = {}): number {
  if (argsContainHelp(args)) return printVerbHelp("grant");

  let autonomy: string | undefined;
  let expires: string | undefined;
  let delegateUi = false;
  let relay = false;
  let list = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--autonomy") {
      autonomy = args[++i];
    } else if (a === "--expires") {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) {
        return fail("--expires takes <n>h, <n>d or <n>w (n > 0).");
      }
      expires = v;
    } else if (a === "--delegate-ui") {
      delegateUi = true;
    } else if (a === "--relay") {
      relay = true;
    } else if (a === "--list") {
      list = true;
    } else if (a.startsWith("--autonomy=") || a.startsWith("--expires=")) {
      return fail(
        `use '${a.split("=")[0]} <value>' (space-separated), not the '=' form.`,
      );
    } else if (a.startsWith("-")) {
      return fail(`unknown option '${a}'.`);
    } else {
      positionals.push(a);
    }
  }

  if (list) {
    if (positionals.length > 0 || autonomy || expires || delegateUi || relay) {
      return fail("--list takes no other arguments.");
    }
    return runList(deps);
  }

  if (positionals.length !== 1) {
    return fail("exactly one <scope> is required.");
  }
  const scope = parseScope(positionals[0]);
  if (!scope) {
    return fail(
      `'${positionals[0]}' is not a scope — use ${ALLOWED_SCOPE_KINDS}.`,
    );
  }
  if (relay) {
    if (autonomy !== undefined) {
      return fail(
        "--relay stands alone: --autonomy high already includes it, and --autonomy off withdraws any grant.",
      );
    }
    if (delegateUi)
      return fail("--delegate-ui only applies with --autonomy high.");
  } else if (autonomy !== "high" && autonomy !== "off") {
    return fail("--autonomy requires 'high' or 'off' (or use --relay).");
  }
  if (autonomy === "off" && (delegateUi || expires !== undefined)) {
    return fail("--delegate-ui and --expires only apply with --autonomy high.");
  }
  let expiresMs: number | undefined;
  if (expires !== undefined) {
    const ms = parseExpires(expires);
    if (ms === null) return fail("--expires takes <n>h, <n>d or <n>w (n > 0).");
    expiresMs = ms;
  }

  const scopeText = formatScope(scope);
  const now = (deps.now ?? (() => new Date()))();
  const ts = now.toISOString();

  if (autonomy === "off") {
    return runOff(scope, scopeText, ts, now, deps);
  }

  const env = deps.env ?? process.env;
  const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY || env.CLAUDECODE) {
    console.error(
      "flow grant: run this in a plain terminal outside any Claude session — a grant must come from your own keystroke. Nothing was written.",
    );
    return 2;
  }

  const cwd = deps.cwd ?? process.cwd();
  const currentRepoRoot = (deps.resolveRepo ?? resolveRepoRoot)(cwd);
  const resolved = resolveScopeTarget(scope, currentRepoRoot, deps.stateDir);
  if ("error" in resolved) {
    console.error(`flow grant: ${resolved.error}`);
    return 2;
  }
  for (const w of resolved.warnings) console.log(`  Warning: ${w}`);

  const priorBaseline =
    scope.kind === "epic" && !relay
      ? readManagerLog({ epic: scope.id }, deps.home).find(
          (e) => e.kind === "grant" && e.exec?.baselineMerged,
        )?.exec?.baselineMerged
      : undefined;
  let baselineMerged: string[] | undefined;
  if (scope.kind === "epic" && !relay) {
    // A re-grant keeps the EARLIEST baseline so merges that landed while the
    // grant was withdrawn are still reviewed.
    const board = resolved.epicRoot
      ? readCommittedStatus(
          path.join(resolved.epicRoot, epicDirRelative(scope.id)),
        )
      : null;
    baselineMerged =
      priorBaseline ??
      Object.entries(board?.features ?? {})
        .filter(([, row]) => row.status === "merged")
        .map(([id]) => id)
        .sort();
  }

  const hadGrant = readGrants(deps.home).some((g) => g.scope === scopeText);
  const classes: GrantClass[] = relay
    ? ["relay"]
    : delegateUi
      ? ["plan", "relay", "subjective"]
      : ["plan", "relay"];
  upsertGrant(
    {
      scope: scopeText,
      classes,
      grantedAt: ts,
      ...(expiresMs !== undefined
        ? { expiresAt: new Date(now.getTime() + expiresMs).toISOString() }
        : {}),
      grantedBy: "owner-cli",
    },
    deps.home,
  );
  appendManagerLog(
    {
      ts,
      kind: "grant",
      scope: scopeText,
      repo: resolved.repo,
      ...(scope.kind === "epic" ? { epic: scope.id } : {}),
      ...(scope.kind === "pipeline" ? { slug: scope.id } : {}),
      reason: relay ? "owner-cli-relay" : "owner-cli",
      ...(baselineMerged
        ? {
            exec: {
              decisionId: `grant-${ts}`,
              reviewKind: "plan" as const,
              baselineMerged,
            },
          }
        : {}),
    },
    { home: deps.home },
  );

  if (relay) {
    console.log(
      `${hadGrant ? "Refreshed" : "Granted"} answer relay for ${scopeText}.`,
    );
    console.log(
      '  What you type in the manager window ("yes #3") is relayed to the paused pipeline in this scope. It does not switch on the executive.',
    );
    if (expiresMs !== undefined) {
      console.log(
        `  Expires: ${new Date(now.getTime() + expiresMs).toISOString()}`,
      );
    }
    console.log(`  Withdraw any time: flow grant ${scopeText} --autonomy off`);
    return 0;
  }
  console.log(
    `${hadGrant ? "Refreshed" : "Granted"} plan-approval autonomy for ${scopeText}.`,
  );
  console.log(
    "  The executive may now approve plans in this scope when it is highly confident and the call is reversible; every decision is logged and stamped in the PR.",
  );
  if (scope.kind !== "pipeline") {
    console.log(
      "  It also allows the executive to reorder unstarted epic features after a wave of merges.",
    );
  }
  if (delegateUi) {
    console.log(
      "  --delegate-ui: recorded, but inactive — delegated UI sign-off is parked, so UI taste items stay with you.",
    );
  }
  console.log(
    "  Cost: a wrong call can let a plan through without you reading it; you will only see it afterward, in the PR stamp and the log.",
  );
  if (expiresMs !== undefined) {
    console.log(
      `  Expires: ${new Date(now.getTime() + expiresMs).toISOString()}`,
    );
  }
  if (!readCharter().found) {
    console.log(
      "  Warning: ~/.flow/product.md has no usable '## Deciding on my behalf' section, so every plan in this scope will still pause for you until you add one.",
    );
  }
  console.log(`  Withdraw any time: flow grant ${scopeText} --autonomy off`);
  return 0;
}

function runOff(
  scope: Scope,
  scopeText: string,
  ts: string,
  now: Date,
  deps: GrantCliDeps,
): number {
  const removed = removeGrant(scopeText, deps.home);
  const ids = identitiesFor(scope, deps.stateDir);
  const priorGrant = readManagerLog({}, deps.home)
    .filter((e) => e.kind === "grant" && e.scope === scopeText)
    .at(-1);
  const repo =
    ids[0]?.repo ??
    priorGrant?.repo ??
    (scope.kind === "repo"
      ? scope.id
      : (() => {
          const root = (deps.resolveRepo ?? resolveRepoRoot)(
            deps.cwd ?? process.cwd(),
          );
          return root ? repoNameForPath(root) : "unknown";
        })());
  const matchIds: PipelineIdentity[] =
    ids.length > 0
      ? ids
      : repo !== "unknown"
        ? [
            {
              slug: scope.kind === "pipeline" ? scope.id : "",
              ...(scope.kind === "epic" ? { epic: scope.id } : {}),
              repo,
            },
          ]
        : [];
  appendManagerLog(
    {
      ts,
      kind: "grant-withdrawn",
      scope: scopeText,
      repo,
      ...(scope.kind === "epic" ? { epic: scope.id } : {}),
      ...(scope.kind === "pipeline" ? { slug: scope.id } : {}),
      reason: removed ? "owner-cli" : "no-grant-present",
    },
    { home: deps.home },
  );
  const broader = liveGrants(now, deps.home).filter((g) => {
    const s = parseScope(g.scope);
    return (
      s !== null &&
      specificity(s) < specificity(scope) &&
      matchIds.some((id) => scopeMatches(s, id))
    );
  });
  if (!removed) {
    console.log(`No grant was on file for ${scopeText}. Nothing changed.`);
  } else if (broader.length === 0) {
    console.log(
      `Withdrew the executive grant for ${scopeText}. Plans there pause for your approval again.`,
    );
  } else {
    console.log(
      `Withdrew the executive grant for ${scopeText}, but plans there are still approved under ${broader.map((g) => g.scope).join(", ")}.`,
    );
  }
  for (const g of broader) {
    console.log(
      `  Still covered by ${g.scope}: withdraw it with: flow grant ${g.scope} --autonomy off`,
    );
  }
  return 0;
}
