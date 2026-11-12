/**
 * Rulings: the only way a pipeline accepts an answer from the manager. A ruling
 * is bound to one pipeline, its current phase and the time it entered that
 * phase, and lives in `~/.flow/manager/rulings/<id>.json`. `writeRuling` (the
 * manager's `flow-manager-ctl ruling write`) refuses out-of-scope pipelines;
 * `verifyRuling` (the pipeline's `flow-exec-review ruling`) re-checks every
 * gate, requires the matching `ruling-written` log line (so a hand-written
 * file is refused), and marks the ruling consumed. Every outcome is logged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkOneWay } from "./exec-review-preconditions";
import { withFileLockSync } from "./lock";
import { grantForSlug } from "./manager-grants";
import {
  managerFile,
  managerHome,
  managerLockPath,
  writeJsonAtomic,
} from "./manager-home";
import { appendManagerLog, readManagerLog } from "./manager-log";
import {
  findOwnerWords,
  readOwnerWords,
  wordsNameTarget,
} from "./manager-owner-words";
import { repoNameForPath, scopeCovers } from "./manager-scope";
import { budgetReached } from "./manager-spend";
import { enteredAt } from "./manager-wait";
import type { ReadConfigFile } from "./modules-config";
import { readState, type PipelineState } from "./state";

export type RulingReply = "approve" | "redirect" | "answer";
export type RulingSource = "manager" | "owner";

export type Ruling = {
  version: 1;
  id: string;
  slug: string;
  repo: string;
  phase: string;
  phaseEnteredAt: string;
  reply: RulingReply;
  text?: string;
  reason: string;
  source: RulingSource;
  decisionId?: string;
  ownerPromptId?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export const RULING_TTL_HOURS = 24;

export type RulingRefusal =
  | "not-found"
  | "wrong-slug"
  | "stale-phase"
  | "expired"
  | "consumed"
  | "no-grant"
  | "source-not-allowed"
  | "no-exec-approval"
  | "no-owner-words"
  | "unlogged"
  | "one-way-door"
  | "budget-reached"
  | "out-of-scope";

export type RulingDeps = {
  home?: string;
  stateDir?: string;
  now?: () => Date;
  random?: () => string;
  readFile?: (p: string) => string;
  readConfig?: ReadConfigFile;
};

/** Which sources may rule which reply in which paused phase. */
const ALLOWED: Record<string, Partial<Record<RulingSource, RulingReply[]>>> = {
  "plan-pending-review": {
    manager: ["approve", "redirect"],
    owner: ["approve", "redirect"],
  },
  "triaged-no-change": { owner: ["approve", "redirect"] },
  "plan-pending-interview": { owner: ["answer"] },
  "triage-pending-interview": { owner: ["answer"] },
  "triage-pending-clarification": { owner: ["answer"] },
  "approval-pending-clarification": { owner: ["answer"] },
};

const MAX_TEXT = 4000;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function rulingPath(id: string, home: string): string {
  return path.join(managerFile("rulings", home), `${id}.json`);
}

function readRuling(id: string, home: string): Ruling | null {
  if (!SAFE_ID.test(id)) return null;
  try {
    const v = JSON.parse(
      fs.readFileSync(rulingPath(id, home), "utf8"),
    ) as Ruling;
    return v?.version === 1 && v.id === id ? v : null;
  } catch {
    return null;
  }
}

const at = (iso: string) => Date.parse(iso);

type Ctx = {
  home: string;
  state: PipelineState;
  now: Date;
  deps: RulingDeps;
};

/** Every gate after the binding checks; shared by the writer (early feedback) and the verifier. */
function gateRefusal(r: Ruling, c: Ctx): RulingRefusal | null {
  const grant = grantForSlug(r.slug, {
    stateDir: c.deps.stateDir,
    home: c.home,
    now: () => c.now,
  });
  const classes = grant.granted ? grant.classes : [];
  const granted =
    r.source === "manager"
      ? classes.includes("plan")
      : classes.includes("plan") || classes.includes("relay");
  if (!granted) return "no-grant";

  if (!ALLOWED[r.phase]?.[r.source]?.includes(r.reply)) {
    return "source-not-allowed";
  }

  if (r.source === "manager") {
    const d = readManagerLog({ slug: r.slug }, c.home).find(
      (e) =>
        e.kind === "exec-decision" &&
        e.exec?.reviewKind === "plan" &&
        e.exec.decisionId === r.decisionId &&
        at(e.ts) >= at(r.phaseEnteredAt) &&
        (r.reply === "approve"
          ? e.exec.action === "approve"
          : e.exec.action === "challenge" ||
            e.exec.recommendationAction === "redirect"),
    );
    if (r.decisionId === undefined || !d) return "no-exec-approval";
  } else {
    const w = readOwnerWords(c.home).find((x) => x.id === r.ownerPromptId);
    if (
      !w ||
      at(w.ts) < at(r.phaseEnteredAt) ||
      !wordsNameTarget(w.text, r, c.home)
    ) {
      return "no-owner-words";
    }
  }

  if (r.reply === "approve" && r.phase === "plan-pending-review") {
    let plan = "";
    try {
      plan = (c.deps.readFile ?? ((p) => fs.readFileSync(p, "utf8")))(
        path.join(c.state.worktree ?? "", ".flow-tmp", "plan.md"),
      );
    } catch {
      return "one-way-door";
    }
    if (!checkOneWay(plan).ok) return "one-way-door";
  }

  if (
    r.source === "manager" &&
    budgetReached(c.now, { read: c.deps.readConfig, home: c.home }).reached
  ) {
    return "budget-reached";
  }
  return null;
}

const nowOf = (d: RulingDeps) => (d.now ?? (() => new Date()))();

export function writeRuling(
  input: {
    slug: string;
    reply: RulingReply;
    text?: string;
    reason: string;
    source: RulingSource;
    decisionId?: string;
  },
  deps: RulingDeps = {},
):
  | { ok: true; ruling: Ruling; message: string }
  | { ok: false; reason: RulingRefusal } {
  const home = deps.home ?? managerHome();
  const state = readState(input.slug, deps.stateDir);
  if (!state || !scopeCovers(input.slug, { stateDir: deps.stateDir, home })) {
    return { ok: false, reason: "out-of-scope" };
  }
  const now = nowOf(deps);
  const phaseEnteredAt = enteredAt(state);
  const rand = deps.random?.() ?? Math.random().toString(16).slice(2, 8);
  const id = `r-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${rand}`;
  const owner =
    input.source === "owner"
      ? findOwnerWords(
          { slug: input.slug, phase: state.phase },
          phaseEnteredAt,
          home,
        )
      : null;
  const text = input.text?.trim().slice(0, MAX_TEXT);
  const ruling: Ruling = {
    version: 1,
    id,
    slug: input.slug,
    repo: repoNameForPath(state.repo),
    phase: state.phase,
    phaseEnteredAt,
    reply: input.reply,
    ...(text ? { text } : {}),
    reason: input.reason.trim().slice(0, 500),
    source: input.source,
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    ...(owner ? { ownerPromptId: owner.id } : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + RULING_TTL_HOURS * 3_600_000,
    ).toISOString(),
  };
  const refusal = gateRefusal(ruling, { home, state, now, deps });
  if (refusal) {
    logRuling("ruling-refused", ruling, home, now, refusal);
    return { ok: false, reason: refusal };
  }
  withFileLockSync(managerLockPath("rulings", home), () => {
    writeJsonAtomic(rulingPath(id, home), ruling);
    logRuling(
      "ruling-written",
      ruling,
      home,
      now,
      `${ruling.reply} (${ruling.source})`,
    );
  });
  return { ok: true, ruling, message: `RULING ${id}` };
}

function logRuling(
  kind: "ruling-written" | "ruling-accepted" | "ruling-refused",
  r: Pick<Ruling, "id" | "slug" | "repo" | "phase">,
  home: string,
  now: Date,
  reason: string,
): void {
  appendManagerLog(
    {
      ts: now.toISOString(),
      kind,
      repo: r.repo,
      slug: r.slug,
      phase: r.phase,
      key: `ruling:${r.id}`,
      reason,
    },
    { home },
  );
}

export function verifyRuling(
  slug: string,
  id: string,
  deps: RulingDeps = {},
):
  | {
      ok: true;
      reply: RulingReply;
      text?: string;
      source: RulingSource;
      decisionId?: string;
    }
  | { ok: false; reason: RulingRefusal } {
  const home = deps.home ?? managerHome();
  const now = nowOf(deps);
  const state = readState(slug, deps.stateDir);
  const refuse = (reason: RulingRefusal, r?: Ruling) => {
    logRuling(
      "ruling-refused",
      r ?? {
        id,
        slug,
        repo: state ? repoNameForPath(state.repo) : "unknown",
        phase: state?.phase ?? "unknown",
      },
      home,
      now,
      reason,
    );
    return { ok: false as const, reason };
  };

  return withFileLockSync(managerLockPath("rulings", home), () => {
    const r = readRuling(id, home);
    if (!r) return refuse("not-found");
    if (r.slug !== slug) return refuse("wrong-slug", r);
    if (
      !state ||
      state.phase !== r.phase ||
      enteredAt(state) !== r.phaseEnteredAt
    ) {
      return refuse("stale-phase", r);
    }
    if (at(r.expiresAt) <= now.getTime()) return refuse("expired", r);
    if (r.consumedAt) return refuse("consumed", r);
    const logged = readManagerLog({ slug }, home).some(
      (e) => e.kind === "ruling-written" && e.key === `ruling:${id}`,
    );
    if (!logged) return refuse("unlogged", r);
    const refusal = gateRefusal(r, { home, state, now, deps });
    if (refusal) return refuse(refusal, r);
    writeJsonAtomic(rulingPath(id, home), {
      ...r,
      consumedAt: now.toISOString(),
    });
    logRuling("ruling-accepted", r, home, now, `${r.reply} (${r.source})`);
    return {
      ok: true as const,
      reply: r.reply,
      ...(r.text ? { text: r.text } : {}),
      source: r.source,
      ...(r.decisionId ? { decisionId: r.decisionId } : {}),
    };
  });
}
