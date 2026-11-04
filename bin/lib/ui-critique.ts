/**
 * Pure decisions behind the UI critique-and-fix loop: when it runs and in
 * which mode, which shots go to the critic, whether a critic reply is valid,
 * whether a fix round is kept, and which page-check defects are persistent.
 * No I/O, no LLM — the `flow-ui-critique` CLI wires these to files.
 */
import type { UiReviewTarget } from "./ui-review-scope";

export type CritiqueSeverity = "defect" | "major" | "minor";

export type CritiqueFinding = {
  id: string;
  severity: CritiqueSeverity;
  route: string;
  section: string;
  viewport: string;
  shot: string;
  observation: string;
  rule: string;
  fix: string;
  /**
   * Whether the defect sits on surface the PR changed. A reply without it
   * parses as `true`, so an older critic never silently un-gates a defect.
   */
  introduced: boolean;
};

/** Only PR-introduced defects (and a target not showing its state) gate. */
export const isGating = (f: Pick<CritiqueFinding, "introduced" | "rule">) =>
  f.introduced !== false || f.rule === "state-mismatch";

const SEVERITIES: readonly string[] = ["defect", "major", "minor"];
const FINDING_FIELDS = [
  "id",
  "route",
  "section",
  "viewport",
  "shot",
  "observation",
  "rule",
  "fix",
] as const;
const MAX_FINDINGS = 20;
const MAX_CHARS = 300;

/**
 * A finding whose `shot` is not in the gallery proves nothing about what the
 * critic actually saw, so it is dropped and counted rather than trusted.
 */
export function validateFindings(
  raw: unknown,
  galleryPaths: string[],
):
  | { ok: true; findings: CritiqueFinding[]; dropped: number }
  | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "reply must be a JSON object" };
  }
  const list = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(list)) {
    return { ok: false, reason: "'findings' must be an array" };
  }
  if (list.length > MAX_FINDINGS) {
    return { ok: false, reason: `more than ${MAX_FINDINGS} findings` };
  }
  const allowed = new Set(galleryPaths);
  const findings: CritiqueFinding[] = [];
  let dropped = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      return { ok: false, reason: `findings[${i}] must be an object` };
    }
    const o = f as Record<string, unknown>;
    for (const field of FINDING_FIELDS) {
      const v = o[field];
      if (typeof v !== "string" || v.length === 0 || v.length > MAX_CHARS) {
        return {
          ok: false,
          reason: `findings[${i}].${field} must be a non-empty string of at most ${MAX_CHARS} chars`,
        };
      }
    }
    if (typeof o.severity !== "string" || !SEVERITIES.includes(o.severity)) {
      return {
        ok: false,
        reason: `findings[${i}].severity must be one of ${SEVERITIES.join(", ")}`,
      };
    }
    if (!allowed.has(o.shot as string)) {
      dropped++;
      continue;
    }
    if (o.introduced !== undefined && typeof o.introduced !== "boolean") {
      return {
        ok: false,
        reason: `findings[${i}].introduced must be a boolean`,
      };
    }
    findings.push({
      ...(o as unknown as CritiqueFinding),
      introduced: o.introduced !== false,
    });
  }
  return { ok: true, findings, dropped };
}

export type RoundKind = "smell" | "critique";

export type LoopOutcome =
  | "kept"
  | "reverted"
  | "clean"
  | "list-only"
  | "skipped";

export type LoopLog = {
  mode: "fix" | "list-only";
  round: {
    kind: RoundKind;
    preSha: string;
    open: boolean;
    decision?: "keep" | "revert";
    reason?: string;
  } | null;
  outcome: LoopOutcome | null;
  residual: CritiqueFinding[];
  persistent: string[];
  omittedSections: number;
  costUsd: number;
  completed: boolean;
  critiqueCalls: string[];
  skip?: string;
  /** The diff needed a review — recorded so the gate backstop can read it. */
  required?: boolean;
  /** HEAD the critic judged; stamped at critique and on a kept round. */
  headSha?: string;
  targets?: UiReviewTarget[];
  playwrightWarning?: string;
  /** Advisory judgment of the sign-off screenshots; never gates. */
  signoff?: { findings: CritiqueFinding[]; judgedSha: string };
};

const OUTCOMES: readonly string[] = [
  "kept",
  "reverted",
  "clean",
  "list-only",
  "skipped",
];

export function emptyLoopLog(): LoopLog {
  return {
    mode: "fix",
    round: null,
    outcome: null,
    residual: [],
    persistent: [],
    omittedSections: 0,
    costUsd: 0,
    completed: false,
    critiqueCalls: [],
  };
}

/** Tolerant read: a missing or malformed log is an empty one. */
export function parseLoopLog(raw: string | null): LoopLog {
  const out = emptyLoopLog();
  if (raw === null) return out;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return out;
    o = parsed as Record<string, unknown>;
  } catch {
    return out;
  }
  if (o.mode === "list-only") out.mode = "list-only";
  const r = o.round;
  if (typeof r === "object" && r !== null) {
    const round = r as Record<string, unknown>;
    if (
      (round.kind === "smell" || round.kind === "critique") &&
      typeof round.preSha === "string" &&
      typeof round.open === "boolean"
    ) {
      out.round = {
        kind: round.kind,
        preSha: round.preSha,
        open: round.open,
        ...(round.decision === "keep" || round.decision === "revert"
          ? { decision: round.decision }
          : {}),
        ...(typeof round.reason === "string" ? { reason: round.reason } : {}),
      };
    }
  }
  if (typeof o.outcome === "string" && OUTCOMES.includes(o.outcome)) {
    out.outcome = o.outcome as LoopOutcome;
  }
  if (Array.isArray(o.residual)) {
    out.residual = o.residual.filter(
      (f): f is CritiqueFinding => typeof f === "object" && f !== null,
    );
  }
  if (Array.isArray(o.persistent)) {
    out.persistent = o.persistent.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (typeof o.omittedSections === "number") {
    out.omittedSections = o.omittedSections;
  }
  if (typeof o.costUsd === "number") out.costUsd = o.costUsd;
  if (o.completed === true) out.completed = true;
  if (Array.isArray(o.critiqueCalls)) {
    out.critiqueCalls = o.critiqueCalls.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (typeof o.skip === "string") out.skip = o.skip;
  if (typeof o.required === "boolean") out.required = o.required;
  if (typeof o.headSha === "string") out.headSha = o.headSha;
  if (typeof o.playwrightWarning === "string") {
    out.playwrightWarning = o.playwrightWarning;
  }
  const so = o.signoff as { findings?: unknown; judgedSha?: unknown } | null;
  if (
    typeof so === "object" &&
    so !== null &&
    Array.isArray(so.findings) &&
    typeof so.judgedSha === "string"
  ) {
    out.signoff = {
      findings: so.findings.filter(
        (f): f is CritiqueFinding => typeof f === "object" && f !== null,
      ),
      judgedSha: so.judgedSha,
    };
  }
  if (Array.isArray(o.targets)) {
    out.targets = o.targets.filter(
      (t): t is UiReviewTarget =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { route?: unknown }).route === "string",
    );
  }
  return out;
}

const RANK: Record<CritiqueSeverity, number> = {
  defect: 3,
  major: 2,
  minor: 1,
};

export const findingKey = (
  f: Pick<CritiqueFinding, "route" | "section" | "viewport">,
): string => `${f.route} | ${f.section} | ${f.viewport}`;

function worstByKey(findings: CritiqueFinding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of findings) {
    const key = findingKey(f);
    m.set(key, Math.max(m.get(key) ?? 0, RANK[f.severity]));
  }
  return m;
}

/**
 * A fix round is kept only when the deterministic no-regression check passed,
 * every targeted defect/major location got strictly better, and no new
 * defect/major appeared where there was none.
 */
export function acceptRound(i: {
  regressed: boolean;
  targeted: CritiqueFinding[];
  after: CritiqueFinding[];
  /** `route | section | viewport` keys present in the post-round gallery. */
  afterKeys?: Set<string>;
}): { decision: "keep" | "revert"; reason: string } {
  const revert = (reason: string) => ({ decision: "revert" as const, reason });
  if (i.regressed) {
    return revert(
      "the page checks got worse (a new defect, more small layout problems, or lost content)",
    );
  }
  const before = worstByKey(i.targeted.filter(isGating));
  const after = worstByKey(i.after.filter(isGating));
  const targetedKeys = [...before].filter(([, rank]) => rank >= RANK.major);
  if (targetedKeys.length === 0) {
    return revert("no targeted defect or major finding to improve");
  }
  for (const [key, rank] of targetedKeys) {
    if (i.afterKeys && !i.afterKeys.has(key)) {
      return revert(`${key} was not in the post-round screenshots`);
    }
    if ((after.get(key) ?? 0) >= rank) {
      return revert(`${key} did not improve`);
    }
  }
  for (const [key, rank] of after) {
    if (rank >= RANK.major && (before.get(key) ?? 0) < RANK.major) {
      return revert(`a new defect or major finding appeared at ${key}`);
    }
  }
  return {
    decision: "keep",
    reason: "every targeted location improved with no regression",
  };
}

/**
 * Page-check defects that survived the whole verify budget unchanged. Only
 * "all persistent" when nothing else failed in the last attempt, so a mixed
 * failure still goes through the normal fix loop.
 */
export function persistentDefects(
  attempts: string[][],
  latestOtherFailures: number,
): { allPersistent: boolean; persistent: string[] } {
  const latest = attempts[attempts.length - 1] ?? [];
  const persistent = latest.filter((m) => attempts.every((a) => a.includes(m)));
  const allPersistent =
    attempts.length >= 3 &&
    latestOtherFailures === 0 &&
    latest.length > 0 &&
    persistent.length === latest.length;
  return { allPersistent, persistent };
}
