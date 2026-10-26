/**
 * The non-LLM subcommands of `flow-ui-critique`: the gate, the round
 * bookkeeping that makes a revert and a resumed loop safe, the persistent
 * page-check defect history, and the PR-section render. Each op takes parsed
 * flags plus injected deps and returns the JSON object the CLI prints; a
 * runtime failure is `{ran:false, skipReason}`, never a thrown error.
 */
import * as path from "node:path";

import { readUiCritiqueEnabled } from "./ui-critique-config";
import {
  acceptRound,
  decideGate,
  findingKey,
  parseLoopLog,
  persistentDefects,
  type CritiqueFinding,
  type LoopLog,
  type RoundKind,
} from "./ui-critique";
import {
  appendLedger,
  decideDemotion,
  ledgerPath,
  readLedger,
  type LedgerLine,
} from "./ui-critique-ledger";
import {
  renderUiReview,
  residualDecisionItem,
  UI_REVIEW_CLOSE,
  upsertUiReview,
} from "./ui-critique-render";
import { stripLocalImageRefs } from "./review-screenshots";
import type { SectionShot } from "./ui-driver-schema";

export type OpsDeps = {
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string) => void;
  copyFile: (from: string, to: string) => void;
  fileExists: (p: string) => boolean;
  mkdirp: (dir: string) => void;
  gitHead: (worktree: string) => string | null;
  resolveSkillPath: (skill: string, ref: string) => string | null;
  home: string;
  now: () => string;
  repo: (worktree: string) => string;
  slug: (worktree: string) => string;
};

export type Flags = Record<string, string | boolean | undefined>;
export type OpResult = Record<string, unknown>;

const PRE_ROUND_FILES = [
  "ui-driver-result.json",
  "ui-captures.json",
  "ui-findings.json",
] as const;

export const critDir = (w: string): string =>
  path.join(w, ".flow-tmp", "ui-critique");
const logFile = (w: string): string => path.join(critDir(w), "log.json");
const failed = (skipReason: string): OpResult => ({ ran: false, skipReason });
const str = (v: string | boolean | undefined): string =>
  typeof v === "string" ? v : "";

export function readJson(deps: OpsDeps, p: string): unknown {
  const raw = deps.readFile(p);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readLog(deps: OpsDeps, w: string): LoopLog {
  return parseLoopLog(deps.readFile(logFile(w)));
}

export function writeLog(deps: OpsDeps, w: string, log: LoopLog): void {
  deps.mkdirp(critDir(w));
  deps.writeFile(logFile(w), JSON.stringify(log, null, 2) + "\n");
}

/** A findings file is either a bare array or `{findings: [...]}`. */
export function readFindings(
  deps: OpsDeps,
  p: string,
): CritiqueFinding[] | null {
  const j = readJson(deps, p) as { findings?: unknown } | unknown[] | null;
  const list = Array.isArray(j) ? j : j?.findings;
  return Array.isArray(list) ? (list as CritiqueFinding[]) : null;
}

function ledgerAppend(
  deps: OpsDeps,
  w: string,
  line: Pick<LedgerLine, "outcome" | "costUsd">,
): void {
  appendLedger(
    { at: deps.now(), repo: deps.repo(w), slug: deps.slug(w), ...line },
    {
      path: ledgerPath(deps.home),
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      mkdirp: deps.mkdirp,
    },
  );
}

function demotion(deps: OpsDeps): { demoted: boolean; reason: string } {
  return decideDemotion(readLedger(deps.readFile(ledgerPath(deps.home))));
}

type DriverResult = {
  ran?: boolean;
  ok?: boolean;
  skipped_reason?: string;
  section_shots?: SectionShot[];
  fix_context?: Record<string, unknown>[];
};

function readDriver(deps: OpsDeps, p: string): DriverResult | null {
  const j = readJson(deps, p);
  return typeof j === "object" && j !== null && !Array.isArray(j)
    ? (j as DriverResult)
    : null;
}

export function opGate(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  const body = deps.readFile(str(f["body-file"]));
  if (body === null) return failed("body-unreadable");
  let ui = null;
  if (typeof f["driver-result"] === "string") {
    const d = readDriver(deps, f["driver-result"]);
    ui = {
      ran: d?.ran === true,
      ok: d?.ok === true,
      skippedReason: d ? (d.skipped_reason ?? null) : "driver-no-artifact",
      sectionShots: d?.section_shots?.length ?? 0,
    };
  }
  const enabled = readUiCritiqueEnabled(() =>
    deps.readFile(path.join(deps.home, ".flow", "config.json")),
  );
  return {
    ...decideGate({
      body,
      enabled,
      ui,
      log: readLog(deps, w),
      demotion: demotion(deps),
    }),
  };
}

export function opRoundBegin(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  const kind = f.kind;
  if (kind !== "smell" && kind !== "critique") return failed("bad-kind");
  const preSha = deps.gitHead(w);
  if (preSha === null) return failed("git-head-unavailable");
  const pre = path.join(critDir(w), "pre-round");
  deps.mkdirp(pre);
  for (const name of PRE_ROUND_FILES) {
    const src = path.join(w, ".flow-tmp", name);
    if (deps.fileExists(src)) deps.copyFile(src, path.join(pre, name));
  }
  // The round is recorded open BEFORE any fix is made, so a crash mid-fix
  // leaves a resumable record with the pre-round SHA to revert to.
  writeLog(deps, w, {
    ...readLog(deps, w),
    round: { kind: kind as RoundKind, preSha, open: true },
  });
  return { preSha };
}

export function opRoundEnd(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  const log = readLog(deps, w);
  if (!log.round?.open) return failed("no-open-round");
  if (f.decision !== "keep" && f.decision !== "revert") {
    return failed("bad-decision");
  }
  const keep = f.decision === "keep";
  if (!keep) {
    const head = deps.gitHead(w);
    const pre = path.join(critDir(w), "pre-round");
    for (const name of PRE_ROUND_FILES) {
      const saved = path.join(pre, name);
      if (deps.fileExists(saved))
        deps.copyFile(saved, path.join(w, ".flow-tmp", name));
    }
    // The tree now equals the pre-round one, so the restored artifact is
    // fresh for the current HEAD again.
    const driverPath = path.join(w, ".flow-tmp", "ui-driver-result.json");
    const restored = readDriver(deps, driverPath);
    if (restored && head) {
      deps.writeFile(
        driverPath,
        JSON.stringify({ ...restored, headSha: head }, null, 2) + "\n",
      );
    }
  }
  const cost = Number(str(f.cost)) || 0;
  const residual =
    typeof f["residual-file"] === "string"
      ? readFindings(deps, f["residual-file"])
      : null;
  const { skip: _skip, ...rest } = log;
  const next: LoopLog = {
    ...rest,
    round: {
      ...log.round,
      open: false,
      decision: keep ? "keep" : "revert",
      reason: str(f.reason),
    },
    outcome: keep ? "kept" : "reverted",
    residual: residual ?? log.residual,
    costUsd: log.costUsd + cost,
    // The loop is one round, ever: closing it completes the log.
    completed: true,
  };
  writeLog(deps, w, next);
  if (log.round.kind === "critique") {
    ledgerAppend(deps, w, {
      outcome: next.outcome as "kept" | "reverted",
      costUsd: next.costUsd,
    });
  }
  return { closed: true, outcome: next.outcome };
}

export function opRecord(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  const outcome = f.outcome;
  if (outcome !== "clean" && outcome !== "list-only" && outcome !== "skipped") {
    return failed("bad-outcome");
  }
  const log = readLog(deps, w);
  const residual =
    typeof f["residual-file"] === "string"
      ? readFindings(deps, f["residual-file"])
      : null;
  const { skip: _skip, ...rest } = log;
  const next: LoopLog = {
    ...rest,
    outcome,
    mode: outcome === "list-only" ? "list-only" : log.mode,
    residual: residual ?? log.residual,
    omittedSections: Number(str(f.omitted)) || log.omittedSections,
    costUsd: log.costUsd + (Number(str(f.cost)) || 0),
    completed: f.complete === true ? true : log.completed,
    ...(outcome === "skipped" ? { skip: str(f.reason) } : {}),
  };
  writeLog(deps, w, next);
  if (outcome !== "skipped")
    ledgerAppend(deps, w, { outcome, costUsd: next.costUsd });
  return { recorded: true, outcome };
}

type Attempt = { issues: string[]; other: number };

export function opPersistent(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  const histFile = path.join(critDir(w), "defect-history.json");
  const hist = readJson(deps, histFile) as { attempts?: Attempt[] } | null;
  const attempts: Attempt[] = Array.isArray(hist?.attempts)
    ? hist.attempts
    : [];
  if (typeof f.record === "string") {
    const d = readDriver(deps, f.record);
    if (!d || d.ran !== true) return { recorded: false };
    const ctx = d.fix_context ?? [];
    const list = (e: Record<string, unknown>, k: string): string[] =>
      Array.isArray(e[k]) ? (e[k] as string[]) : [];
    const issues = ctx.flatMap((e) => list(e, "heuristicIssues"));
    // An element past the viewport also widens the page, so its own
    // "horizontal overflow" geometry line is the same defect, not a second
    // failure class that would block the persistent-defect hand-off.
    const geometry = (e: Record<string, unknown>): string[] => {
      const heuristic = list(e, "heuristicIssues");
      return list(e, "geometryIssues").filter((g) => {
        const tag = g.match(/^(\[[^\]]*\]) horizontal overflow/)?.[1];
        return !(
          tag && heuristic.some((h) => h.startsWith(`${tag} past-viewport:`))
        );
      });
    };
    const other = ctx.reduce(
      (n, e) =>
        n +
        geometry(e).length +
        ["consoleErrors", "failedRequests", "missingSelectors"].reduce(
          (m, k) => m + list(e, k).length,
          0,
        ),
      0,
    );
    deps.mkdirp(critDir(w));
    deps.writeFile(
      histFile,
      JSON.stringify({ attempts: [...attempts, { issues, other }] }, null, 2) +
        "\n",
    );
    return { recorded: true, attempts: attempts.length + 1 };
  }
  if (f.check === true) {
    const verdict = persistentDefects(
      attempts.map((a) => a.issues),
      attempts[attempts.length - 1]?.other ?? 0,
    );
    if (verdict.allPersistent) {
      writeLog(deps, w, {
        ...readLog(deps, w),
        persistent: verdict.persistent,
      });
    }
    return { ...verdict };
  }
  return failed("persistent-needs-record-or-check");
}

export function opRender(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  const bodyFile = str(f["body-file"]);
  const body = deps.readFile(bodyFile);
  if (body === null) return failed("body-unreadable");
  const log = readLog(deps, w);
  if (typeof f.skip === "string") log.skip = f.skip;
  const round0 = readDriver(deps, path.join(critDir(w), "round-0-driver.json"));
  const after = readDriver(deps, path.join(critDir(w), "after-driver.json"));
  const demoted = demotion(deps);
  const section = renderUiReview({
    before: round0?.section_shots ?? [],
    after: log.outcome === "kept" ? (after?.section_shots ?? null) : null,
    log,
    demotion:
      log.mode === "list-only"
        ? demoted.reason || "recent critique rounds were reverted"
        : null,
  });
  const decision = residualDecisionItem(
    log.skip ? [] : log.residual,
    log.persistent,
  );
  const next = upsertUiReview(body, section, decision);
  deps.writeFile(bodyFile, next);
  deps.writeFile(path.join(w, ".flow-tmp", "ui-review.md"), section + "\n");
  if (typeof f["push-copy"] === "string") {
    const note = "Screenshots for this section attach when the review runs.";
    const stripped = stripLocalImageRefs(next).replace(
      UI_REVIEW_CLOSE,
      `${note}\n${UI_REVIEW_CLOSE}`,
    );
    deps.writeFile(f["push-copy"], stripped);
  }
  return {
    residualDefects: log.skip
      ? 0
      : log.residual.filter((r) => r.severity === "defect").length,
    persistentDefects: log.persistent.length,
    decisionAdded: decision !== null,
  };
}

export function opAccept(f: Flags, deps: OpsDeps): OpResult {
  const compare = readJson(deps, str(f.compare)) as {
    regressed?: unknown;
  } | null;
  const targeted = readFindings(deps, str(f.targeted));
  if (
    compare === null ||
    typeof compare.regressed !== "boolean" ||
    targeted === null
  ) {
    return {
      decision: "revert",
      reason: "the comparison or targeted findings were unreadable",
    };
  }
  const after =
    typeof f.after === "string" ? readFindings(deps, f.after) : null;
  if (after === null && !compare.regressed) {
    return {
      decision: "revert",
      reason:
        "the post-round critique is unavailable, so the round cannot be verified",
    };
  }
  const shots =
    typeof f["after-driver"] === "string"
      ? readDriver(deps, f["after-driver"])?.section_shots
      : undefined;
  const afterKeys = shots ? new Set(shots.map(findingKey)) : undefined;
  return {
    ...acceptRound({
      regressed: compare.regressed,
      targeted,
      after: after ?? [],
      afterKeys,
    }),
  };
}
