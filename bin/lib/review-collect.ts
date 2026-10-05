/**
 * `/flow-pr-review`'s three agent-result boundaries (lens fan-out wait,
 * Step 3.5 consolidator read, Step 8 fix-applier read) as one bounded
 * helper call each: poll `.flow-tmp/` every 5 s up to `waitSec` for the
 * stage's artifacts, validate with the EXISTING validators exactly as the
 * `flow-agent-finding-schema` CLI does (`normalizeParsedFindings` first),
 * and return one envelope.
 *
 * The helper NEVER writes `pr-review-result.json` — it only names the
 * escalation tag; the supervisor applies `references/escalation-recipes.md`
 * (whose read-before-overwrite guard a helper write would bypass). The
 * lens digest is per-lens counts only: the wrapper never reads per-lens
 * findings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizeParsedFindings,
  validateAgentFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";
import { validateFixApplierResult } from "./fix-applier-schema";

export type CollectStage = "lenses" | "consolidator" | "fix-applier";

export type CollectEnvelope = {
  stage: CollectStage;
  ready: boolean;
  valid: boolean;
  waitedSec: number;
  escalationTag:
    | "consolidator-missing-artifact"
    | "consolidator-schema-failure"
    | "fix-applier-missing-artifact"
    | null;
  digest: unknown;
};

export type CollectOptions = {
  stage: CollectStage;
  worktree: string;
  waitSec: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type LensDigest = {
  lens: string;
  present: boolean;
  valid: boolean;
  findingCount: number;
};

const POLL_MS = 5000;
const MANDATORY_LENSES = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
] as const;
const TOLERATED_LENSES = ["product", "gemini"] as const;
const INTENT_GUESS_KEYS = [
  "guessed_purpose",
  "key_changes",
  "justification",
  "confidence",
] as const;

type Eval = Omit<CollectEnvelope, "stage" | "waitedSec">;

/** `undefined` = file absent; `null` = present but not parseable JSON. */
function readJson(file: string): unknown | null | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readScope(dir: string): {
  gates: Record<string, { run?: boolean }> | null;
  delta: boolean;
} {
  const scope = readJson(path.join(dir, "review-scope.json"));
  if (!isObject(scope)) return { gates: null, delta: false };
  return {
    gates: isObject(scope.gates)
      ? (scope.gates as Record<string, { run?: boolean }>)
      : null,
    delta: scope.scope === "delta",
  };
}

function lensDigest(lens: string, parsed: unknown): LensDigest {
  if (lens === "intent-guess") {
    const valid =
      isObject(parsed) && INTENT_GUESS_KEYS.every((k) => k in parsed);
    return { lens, present: true, valid, findingCount: 0 };
  }
  const normalized = normalizeParsedFindings(parsed);
  const valid = validateAgentFindings(normalized).ok;
  const findings = isObject(normalized) ? normalized.findings : undefined;
  return {
    lens,
    present: true,
    valid,
    findingCount: Array.isArray(findings) ? findings.length : 0,
  };
}

function evalLenses(dir: string): Eval {
  const { gates, delta } = readScope(dir);
  const expected: string[] = gates
    ? Object.entries(gates)
        .filter(([, g]) => isObject(g) && g.run === true)
        .map(([lens]) => lens)
    : [...MANDATORY_LENSES];
  if (!delta) expected.push("intent-guess");

  const digest: LensDigest[] = [];
  let ready = true;
  const lenses = [
    ...expected,
    ...TOLERATED_LENSES.filter((l) => !expected.includes(l)),
  ];
  for (const lens of lenses) {
    const file =
      lens === "intent-guess"
        ? "intent-guess.json"
        : `agent-output-${lens}.json`;
    const parsed = readJson(path.join(dir, file));
    if (parsed === undefined || parsed === null) {
      if (expected.includes(lens)) {
        ready = false;
        digest.push({ lens, present: false, valid: false, findingCount: 0 });
      }
      continue;
    }
    digest.push(lensDigest(lens, parsed));
  }
  return {
    ready,
    valid: ready && digest.every((d) => d.valid),
    escalationTag: null,
    digest,
  };
}

function evalConsolidator(dir: string, final: boolean): Eval {
  const parsed = readJson(path.join(dir, "consolidator-result.json"));
  if (parsed === undefined || (parsed === null && !final)) {
    return {
      ready: false,
      valid: false,
      escalationTag: final ? "consolidator-missing-artifact" : null,
      digest: null,
    };
  }
  const result = validateConsolidatorResult(normalizeParsedFindings(parsed));
  if (!result.ok) {
    return {
      ready: true,
      valid: false,
      escalationTag: "consolidator-schema-failure",
      digest: { reason: result.reason, path: result.path ?? null },
    };
  }
  return {
    ready: true,
    valid: true,
    escalationTag: null,
    digest: result.value,
  };
}

// The step-0 in-progress skeleton is a schema-valid `status: "partial"`
// artifact, so while waiting only `status == "complete"` counts as ready;
// once the agent has returned (`final`), a `partial` artifact is ready+valid
// so the supervisor routes the partial-result continuation.
function evalFixApplier(dir: string, final: boolean): Eval {
  const parsed = readJson(path.join(dir, "fix-applier-result.json"));
  const missing: Eval = {
    ready: false,
    valid: false,
    escalationTag: final ? "fix-applier-missing-artifact" : null,
    digest: null,
  };
  if (parsed === undefined || parsed === null) {
    if (final && parsed === null) {
      return {
        ready: true,
        valid: false,
        escalationTag: "fix-applier-missing-artifact",
        digest: { reason: "artifact is not parseable JSON" },
      };
    }
    return missing;
  }
  if (!final && !(isObject(parsed) && parsed.status === "complete")) {
    return missing;
  }
  const result = validateFixApplierResult(parsed);
  if (!result.ok) {
    return {
      ready: true,
      valid: false,
      escalationTag: "fix-applier-missing-artifact",
      digest: { reason: result.reason, path: result.path ?? null },
    };
  }
  return {
    ready: true,
    valid: true,
    escalationTag: null,
    digest: result.value,
  };
}

export async function runCollect(
  opts: CollectOptions,
): Promise<{ envelope: CollectEnvelope; exitCode: 0 | 1 | 3 }> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dir = path.join(opts.worktree, ".flow-tmp");
  const final = opts.waitSec <= 0;

  const evaluate = (): Eval => {
    switch (opts.stage) {
      case "lenses":
        return evalLenses(dir);
      case "consolidator":
        return evalConsolidator(dir, final);
      case "fix-applier":
        return evalFixApplier(dir, final);
    }
  };

  const start = now();
  const budgetMs = Math.max(0, opts.waitSec) * 1000;
  let ev = evaluate();
  while (!ev.ready && now() - start < budgetMs) {
    await sleep(Math.min(POLL_MS, budgetMs - (now() - start)));
    ev = evaluate();
  }

  const envelope: CollectEnvelope = {
    stage: opts.stage,
    ...ev,
    waitedSec: Math.floor((now() - start) / 1000),
  };
  let exitCode: 0 | 1 | 3;
  if (!ev.ready) exitCode = final ? 1 : 3;
  else if (opts.stage === "lenses") exitCode = 0;
  else exitCode = ev.valid ? 0 : 1;
  return { envelope, exitCode };
}
