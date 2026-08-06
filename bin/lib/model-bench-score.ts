/**
 * Scorer for `flow-model-bench`: per-case mechanical scores, the
 * per-(surface,candidate) clearance rule, schema tax, discrimination
 * checking, and the plain-language report renderer.
 *
 * CONTRACT DEVIATIONS (documented here, not silently absorbed — see the
 * edit-applier artifact for the full rationale):
 *  - `ModelCaseScore` carries an extra `totalAttempts` field beyond the six
 *    named in the plan. The reliability gate ("> 20% of the candidate's
 *    attempts ran:false") needs a denominator that includes ran:false
 *    attempts, but `scoreCase`'s arithmetic (recall/precision/etc.)
 *    deliberately EXCLUDES them (test 1's own pin) — so the denominator has
 *    to be threaded through separately rather than recovered after the
 *    fact.
 *  - `verdict` and `recommend` both take a `caseSurfaces: Record<string,
 *    BenchSurface>` lookup beyond the plan's bare `(scores, opts)` /
 *    `(matrix)` signatures. `CaseScore` carries a `caseId`, never a
 *    `surface` — grouping into the surface-then-candidate matrix the plan
 *    itself asks for is impossible without a case→surface map somewhere.
 *  - `recommend` also takes `scores` directly (not just `matrix`): the
 *    plan's quality-gated tie-break needs each cleared candidate's
 *    recall/latency, which a pass/fail `VerdictCell` does not carry.
 *  - `renderReport`'s "Case discrimination" section omits the
 *    fixture-staleness annotation ("fixture authored N commits ago" once
 *    HEAD is >100 commits past `authoredAtCommit`) — neither `CaseScore`
 *    nor `renderReport`'s own signature carries `BenchCase`/commit-distance
 *    data. Left as a named follow-up rather than fabricated.
 *
 * RECALL SEMANTICS (per-attempt mean, not union-across-attempts):
 *  - `recall` is the MEAN, over each ran attempt, of that single attempt's
 *    own hit rate across required criteria + structuredTuples + planted
 *    defects. A criterion the model hits in only 1 of N attempts
 *    contributes 1/N credit to recall, not full credit.
 *  - This replaced an earlier union-across-attempts recall (a criterion
 *    counted as "hit" if ANY attempt hit it). Production surfaces call the
 *    model once per invocation, never N times and pick the best — union
 *    recall was measuring a capability the bench never exercises in
 *    production, and it saturates at 1.0 as soon as a model hits every
 *    criterion at least once across its repeat tier, which is exactly what
 *    made 12/19 rows non-discriminating in the 2026-08-05 run.
 *  - Every OTHER field on `ModelCaseScore` stays union-across-attempts on
 *    purpose: `requiredMissed`, `defectsCaught`/`defectsMissed`,
 *    `falsePositives`, `precision`, and `vacuous` all answer "is the model
 *    capable of this at all" (an existence question), not "how reliably
 *    does it do this" (recall's question) — collapsing them to per-attempt
 *    mean would make `evaluateCandidate`'s defect-regression gate
 *    unstable (a defect caught in only 1 of N incumbent attempts would
 *    intermittently fail to gate a candidate that misses it every time).
 */

import {
  criterionKeys,
  criterionLabel,
  type BenchArm,
  type BenchResult,
  type BenchSurface,
  type BenchTruth,
  type StructuredTuple,
  type TruthCriterion,
} from "./model-bench-schema";

export type ModelCaseScore = {
  recall: number;
  precision: number;
  // Human-readable desc/label of every unmet `required` criterion — kept
  // separate from `defectsMissed` (which stays fingerprint-keyed, because
  // `evaluateCandidate`'s defect-regression gate matches it against
  // `defectsCaught` by exact fingerprint) so the report can render a
  // readable miss list without breaking that exact-match gate.
  requiredMissed: string[];
  defectsCaught: string[];
  defectsMissed: string[];
  falsePositives: string[];
  vacuous: number;
  pushback?: "named" | "hedged" | "missed" | "over-objected";
  ranAttempts: number;
  totalAttempts: number;
  latency: { median: number; min: number; max: number };
};

export type CaseScore = {
  caseId: string;
  arm: BenchArm;
  spread: number;
  discriminating: boolean;
  perModel: Record<string, ModelCaseScore>;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function defectFingerprint(d: {
  file: string;
  line: number;
  kind: string;
}): string {
  return `${d.file}:${d.line}:${d.kind}`;
}

// Searches both the free-text response AND structuredOutput (stringified) —
// a schema-arm attempt's substantive content often lives entirely in typed
// fields, never in prose, so matching response alone would silently score
// every schema-arm attempt as a miss regardless of correctness.
function textsFor(attempts: BenchResult[]): string[] {
  return attempts.map((a) =>
    `${a.response ?? ""} ${safeStringify(a.structuredOutput)}`.toLowerCase(),
  );
}

function safeStringify(v: unknown): string {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function includesAny(texts: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return texts.some((t) => t.includes(n));
}

// A criterion is met when ANY of its match keys (criterionKeys) appears in
// any scored attempt's combined text.
function criterionMet(texts: string[], c: TruthCriterion): boolean {
  return criterionKeys(c).some((key) => includesAny(texts, key));
}

// True when `obj` (a plain object) carries every key/value pair in `match`.
// Numbers are compared with Number() coercion — a model can carry a numeric
// field as a string (e.g. `"pr": "204"`) even under a JSON schema — so a
// numeric match value accepts either representation; strings/booleans use
// strict ===.
function objectSatisfiesMatch(
  obj: Record<string, unknown>,
  match: Record<string, string | number | boolean>,
): boolean {
  return Object.entries(match).every(([key, expected]) => {
    const actual = obj[key];
    if (typeof expected === "number") {
      return typeof actual === "number" || typeof actual === "string"
        ? Number(actual) === expected
        : false;
    }
    return actual === expected;
  });
}

// Recursively walks any value (object/array) and returns true when SOME
// plain object anywhere within it satisfies every key/value pair in
// `match`. This is the mechanism for a conjunction over structured output
// that substring matching cannot express — a multi-item answer (e.g. one
// verdict per PR) buries the object the criterion cares about at an
// unpredictable key/array nesting that varies by model, so the search has
// to be structural rather than keyed to a fixed path.
function findMatchingObject(
  value: unknown,
  match: Record<string, string | number | boolean>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((v) => findMatchingObject(v, match));
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (objectSatisfiesMatch(obj, match)) return true;
    return Object.values(obj).some((v) => findMatchingObject(v, match));
  }
  return false;
}

// A structuredTuple is met when ANY ran attempt's structuredOutput
// satisfies it. Attempts with no structuredOutput (e.g. a free-form attempt
// that never parsed) simply cannot satisfy a tuple.
function tupleMet(attempts: BenchResult[], tuple: StructuredTuple): boolean {
  return attempts.some(
    (a) =>
      a.structuredOutput !== undefined &&
      findMatchingObject(a.structuredOutput, tuple.match),
  );
}

// A field is "vacuous" when structuredOutput carries it but its value is an
// empty string/array — schema-valid, semantically empty. Predicates that
// don't resolve to a field on structuredOutput are skipped (not counted
// either way) rather than guessed at.
function countVacuous(attempts: BenchResult[], predicates: string[]): number {
  let count = 0;
  for (const attempt of attempts) {
    const structured = attempt.structuredOutput;
    if (typeof structured !== "object" || structured === null) continue;
    const obj = structured as Record<string, unknown>;
    for (const predicate of predicates) {
      if (!(predicate in obj)) continue;
      const v = obj[predicate];
      const empty =
        (typeof v === "string" && v.trim().length === 0) ||
        (Array.isArray(v) && v.length === 0);
      if (empty) count++;
    }
  }
  return count;
}

function classifyPushback(
  texts: string[],
  pushback: { mustName: string[]; mustNotObject?: boolean },
): "named" | "hedged" | "missed" | "over-objected" {
  const namedCount = pushback.mustName.filter((n) =>
    includesAny(texts, n),
  ).length;
  const objects =
    includesAny(texts, "i disagree") || includesAny(texts, "pushing back");
  if (pushback.mustNotObject && objects) return "over-objected";
  if (namedCount === pushback.mustName.length && namedCount > 0) return "named";
  if (namedCount > 0) return "hedged";
  return "missed";
}

// basename-agnostic file matcher for the defects[] matcher below — avoids a
// full-path mismatch when the model output names only the file's basename.
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function scoreCaseForArm(
  attemptsForArm: BenchResult[],
  arm: BenchArm,
  truth: BenchTruth,
): CaseScore {
  const byModel = new Map<string, BenchResult[]>();
  for (const r of attemptsForArm) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }

  const perModel: Record<string, ModelCaseScore> = {};
  for (const [model, allAttempts] of byModel) {
    const attempts = allAttempts.filter((a) => a.ran);
    const texts = textsFor(attempts);

    // Union-across-attempts view: used for every "did the model ever get
    // this" field (requiredMissed, falsePositives, precision, vacuous, the
    // defect-regression gate's defectsCaught/defectsMissed). These stay
    // union because they answer "is this candidate capable of X at all",
    // not "how reliably does it do X" — see `recall` below for the
    // reliability-sensitive metric.
    const requiredHits = truth.required.filter((req) =>
      criterionMet(texts, req),
    );
    const tuples = truth.structuredTuples ?? [];
    const tuplesHit = tuples.filter((t) => tupleMet(attempts, t));
    const requiredMissed = truth.required
      .filter((req) => !criterionMet(texts, req))
      .map(criterionLabel)
      .concat(tuples.filter((t) => !tupleMet(attempts, t)).map((t) => t.desc));

    const forbidden = truth.forbidden ?? [];
    const falsePositives = forbidden
      .filter((f) => criterionMet(texts, f))
      .map(criterionLabel);
    const denom = requiredHits.length + falsePositives.length;
    const precision = denom > 0 ? requiredHits.length / denom : 1;

    // Mechanical, near-agnostic defect match: the output "catches" a planted
    // defect when it names the file's basename AND either the defect's kind
    // string or its line number — either signal alone is too weak (a
    // basename alone could be incidental context; a kind string alone could
    // be a different defect of the same class in a different file).
    const defects = truth.defects ?? [];
    const defectsCaught: string[] = [];
    const defectsMissed: string[] = [];
    for (const d of defects) {
      const fp = defectFingerprint(d);
      const namesFile = includesAny(texts, basename(d.file));
      const namesKindOrLine =
        includesAny(texts, d.kind) || includesAny(texts, String(d.line));
      (namesFile && namesKindOrLine ? defectsCaught : defectsMissed).push(fp);
    }

    // recall: PER-ATTEMPT MEAN, not union-across-attempts. A criterion the
    // model hits in only 1 of N attempts contributes 1/N credit, not full
    // credit — see the file-top comment for why union recall saturates at
    // 1.0 and stops discriminating.
    const recallDenom = truth.required.length + tuples.length + defects.length;
    let recall: number;
    if (attempts.length === 0) {
      recall = 0;
    } else if (recallDenom === 0) {
      recall = 1;
    } else {
      const attemptScores = attempts.map((a) => {
        const singleTexts = textsFor([a]);
        const reqHits = truth.required.filter((req) =>
          criterionMet(singleTexts, req),
        ).length;
        const tHits = tuples.filter((t) => tupleMet([a], t)).length;
        let dHits = 0;
        for (const d of defects) {
          const namesFile = includesAny(singleTexts, basename(d.file));
          const namesKindOrLine =
            includesAny(singleTexts, d.kind) ||
            includesAny(singleTexts, String(d.line));
          if (namesFile && namesKindOrLine) dHits++;
        }
        return (reqHits + tHits + dHits) / recallDenom;
      });
      recall = attemptScores.reduce((a, b) => a + b, 0) / attemptScores.length;
    }

    const vacuous = countVacuous(attempts, truth.emptinessPredicates ?? []);
    const pushback = truth.pushback
      ? classifyPushback(texts, truth.pushback)
      : undefined;

    const durations = attempts
      .map((a) => a.durationSeconds)
      .filter((d): d is number => typeof d === "number");

    perModel[model] = {
      recall,
      precision,
      requiredMissed,
      defectsCaught,
      defectsMissed,
      falsePositives,
      vacuous,
      pushback,
      ranAttempts: attempts.length,
      totalAttempts: allAttempts.length,
      latency: {
        median: median(durations),
        min: durations.length ? Math.min(...durations) : 0,
        max: durations.length ? Math.max(...durations) : 0,
      },
    };
  }

  const modelScores = Object.values(perModel).map((m) => m.recall);
  const spread =
    modelScores.length > 0
      ? Math.max(...modelScores) - Math.min(...modelScores)
      : 0;

  return {
    caseId: truth.caseId,
    arm,
    spread,
    discriminating: spread > 0,
    perModel,
  };
}

// Excludes warmup:true and ran:false attempts from every arithmetic field —
// only `totalAttempts` (the reliability-gate denominator) counts them.
// Returns one CaseScore PER ARM present among this case's scored attempts —
// a case run through both the schema and free-form arms (schemaAb) must
// score each arm independently, never merge them into one averaged score
// (that merge is exactly what made the schema tax always compute to zero).
export function scoreCase(
  results: BenchResult[],
  truth: BenchTruth,
): CaseScore[] {
  const scored = results.filter((r) => r.caseId === truth.caseId && !r.warmup);
  if (scored.length === 0) {
    return [scoreCaseForArm([], "n/a", truth)];
  }
  const arms = [...new Set(scored.map((r) => r.arm))];
  return arms.map((arm) =>
    scoreCaseForArm(
      scored.filter((r) => r.arm === arm),
      arm,
      truth,
    ),
  );
}

export type SchemaTaxResult = {
  perCase: Record<string, number>;
  overall: number;
  recommendedArm: "schema" | "free-form";
};

// tax = free-form recall - schema recall, per model, averaged across every
// case that has BOTH arms scored for that model.
export function schemaTax(
  scores: CaseScore[],
  threshold = 0.05,
): Record<string, SchemaTaxResult> {
  const byCaseArm = new Map<string, CaseScore>();
  for (const s of scores) byCaseArm.set(`${s.caseId}::${s.arm}`, s);
  const caseIds = [...new Set(scores.map((s) => s.caseId))];
  const models = new Set<string>();
  for (const s of scores)
    for (const m of Object.keys(s.perModel)) models.add(m);

  const result: Record<string, SchemaTaxResult> = {};
  for (const model of models) {
    const perCase: Record<string, number> = {};
    for (const caseId of caseIds) {
      const schemaScore = byCaseArm.get(`${caseId}::schema`)?.perModel[model];
      const freeFormScore = byCaseArm.get(`${caseId}::free-form`)?.perModel[
        model
      ];
      if (!schemaScore || !freeFormScore) continue;
      perCase[caseId] = freeFormScore.recall - schemaScore.recall;
    }
    const values = Object.values(perCase);
    const overall =
      values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    result[model] = {
      perCase,
      overall,
      recommendedArm: overall > threshold ? "free-form" : "schema",
    };
  }
  return result;
}

export type VerdictCell = {
  status: "clear" | "reject" | "inconclusive";
  reason: string;
  recommendedArm?: BenchArm;
};

function averageMedianLatency(caseScores: CaseScore[], model: string): number {
  const values = caseScores
    .map((cs) => cs.perModel[model]?.latency.median)
    .filter((v): v is number => typeof v === "number" && v > 0);
  return values.length > 0
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function averageRecall(caseScores: CaseScore[], model: string): number {
  const values = caseScores
    .map((cs) => cs.perModel[model]?.recall)
    .filter((v): v is number => typeof v === "number");
  return values.length > 0
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

const BORDERLINE_TOLERANCE = 0.01;

// Gates evaluated IN THIS ORDER (quality first, latency LAST — a latency
// win with any quality regression is a hard reject, never a weighted
// trade-off). A borderline miss on the parity or latency gate (within
// BORDERLINE_TOLERANCE of the threshold) records inconclusive rather than a
// hard reject.
function evaluateCandidate(
  caseScores: CaseScore[],
  incumbent: string,
  candidate: string,
): VerdictCell {
  for (const cs of caseScores) {
    const inc = cs.perModel[incumbent];
    const cand = cs.perModel[candidate];
    if (!inc || !cand) continue;
    for (const d of inc.defectsCaught) {
      if (cand.defectsMissed.includes(d)) {
        return {
          status: "reject",
          reason: `defect regression on ${cs.caseId}: ${candidate} missed "${d}", which ${incumbent} caught`,
        };
      }
    }
  }

  for (const cs of caseScores) {
    const inc = cs.perModel[incumbent];
    const cand = cs.perModel[candidate];
    if (!inc || !cand) continue;
    const threshold = inc.recall - 0.05;
    if (cand.recall < threshold) {
      if (threshold - cand.recall <= BORDERLINE_TOLERANCE) {
        return {
          status: "inconclusive",
          reason: `mechanical parity borderline on ${cs.caseId} — re-run when models update`,
        };
      }
      return {
        status: "reject",
        reason: `mechanical parity failed on ${cs.caseId}: recall ${cand.recall.toFixed(2)} < incumbent ${inc.recall.toFixed(2)} - 0.05`,
      };
    }
  }

  for (const cs of caseScores) {
    const cand = cs.perModel[candidate];
    if (cand && cand.vacuous > 0) {
      return {
        status: "reject",
        reason: `structured integrity failed on ${cs.caseId}: ${candidate} produced ${cand.vacuous} vacuous field(s) despite schema-valid output`,
      };
    }
  }

  if (caseScores.length > 0 && caseScores.every((cs) => !cs.discriminating)) {
    return {
      status: "inconclusive",
      reason: "test too easy — every backing case is non-discriminating",
    };
  }

  for (const cs of caseScores) {
    const cand = cs.perModel[candidate];
    if (cand && cand.totalAttempts > 0) {
      const failRatio = 1 - cand.ranAttempts / cand.totalAttempts;
      if (failRatio > 0.2) {
        return {
          status: "inconclusive",
          reason: `reliability: ${candidate} failed to run on ${(failRatio * 100).toFixed(0)}% of attempts on ${cs.caseId}`,
        };
      }
    }
  }

  const candMedian = averageMedianLatency(caseScores, candidate);
  const incMedian = averageMedianLatency(caseScores, incumbent);
  if (incMedian > 0) {
    const threshold = 0.6 * incMedian;
    if (candMedian > threshold) {
      if (candMedian - threshold <= BORDERLINE_TOLERANCE * incMedian) {
        return {
          status: "inconclusive",
          reason: "latency payoff borderline — re-run when models update",
        };
      }
      return {
        status: "reject",
        reason: `latency payoff insufficient: ${candidate} median ${candMedian.toFixed(2)}s is not <= 60% of incumbent's ${incMedian.toFixed(2)}s`,
      };
    }
  }

  return {
    status: "clear",
    reason:
      "cleared every gate: no defect regression, mechanical parity held, structured integrity held, discriminating cases available, reliable, and a real latency payoff",
  };
}

export function verdict(
  scores: CaseScore[],
  opts: {
    incumbent: string;
    candidates: string[];
    judged?: Record<string, "worse" | "parity" | "better">;
    caseSurfaces: Record<string, BenchSurface>;
  },
): Record<string, Record<string, VerdictCell>> {
  const bySurface = new Map<string, CaseScore[]>();
  for (const s of scores) {
    const surface = opts.caseSurfaces[s.caseId];
    if (!surface) continue;
    if (!bySurface.has(surface)) bySurface.set(surface, []);
    bySurface.get(surface)!.push(s);
  }

  const matrix: Record<string, Record<string, VerdictCell>> = {};
  for (const [surface, caseScores] of bySurface) {
    matrix[surface] = {};
    for (const candidate of opts.candidates) {
      let cell = evaluateCandidate(caseScores, opts.incumbent, candidate);
      const judgedVerdict =
        opts.judged?.[`${surface}::${candidate}`] ?? opts.judged?.[candidate];
      // A blind 'worse' verdict downgrades a clear to inconclusive; 'better'
      // can never upgrade a reject (no branch handles it — reject/
      // inconclusive pass through untouched).
      if (judgedVerdict === "worse" && cell.status === "clear") {
        cell = {
          status: "inconclusive",
          reason: `blind judge scored ${candidate} worse than ${opts.incumbent} on ${surface}`,
        };
      }
      matrix[surface][candidate] = cell;
    }
  }
  return matrix;
}

export function recommend(
  matrix: Record<string, Record<string, VerdictCell>>,
  scores: CaseScore[],
  caseSurfaces: Record<string, BenchSurface>,
): Record<string, { candidate: string | null; reason: string }> {
  const result: Record<string, { candidate: string | null; reason: string }> =
    {};
  for (const surface of Object.keys(matrix)) {
    const cleared = Object.keys(matrix[surface]!).filter(
      (c) => matrix[surface]![c]!.status === "clear",
    );
    if (cleared.length === 0) {
      result[surface] = {
        candidate: null,
        reason: "no candidate cleared every gate",
      };
      continue;
    }
    const caseScores = scores.filter((s) => caseSurfaces[s.caseId] === surface);
    let best = cleared[0]!;
    let bestQuality = averageRecall(caseScores, best);
    for (const candidate of cleared.slice(1)) {
      const quality = averageRecall(caseScores, candidate);
      // Quality-gated tie-break: only switch to the pricier/slower option
      // when its quality is STRICTLY greater. Equal quality always keeps
      // the cheaper one (per `cleared`'s cheapest-first ordering), however
      // close the latencies are — latency never breaks an equal-quality
      // tie, so it is not consulted here.
      if (quality > bestQuality) {
        best = candidate;
        bestQuality = quality;
      }
    }
    result[surface] = {
      candidate: best,
      reason: `cleared every gate; quality-gated tie-break selected ${best}`,
    };
  }
  return result;
}

function sectionPerSurfaceVerdicts(
  matrix: Record<string, Record<string, VerdictCell>>,
): string {
  const lines = ["## Per-surface verdicts", ""];
  for (const surface of Object.keys(matrix).sort()) {
    for (const candidate of Object.keys(matrix[surface]!).sort()) {
      const cell = matrix[surface]![candidate]!;
      lines.push(
        `- **${surface}** / ${candidate}: ${cell.status} — ${cell.reason}`,
      );
    }
  }
  return lines.join("\n");
}

function sectionWhereWorse(
  matrix: Record<string, Record<string, VerdictCell>>,
): string {
  const lines = ["## Where each candidate was worse", ""];
  let any = false;
  for (const surface of Object.keys(matrix).sort()) {
    for (const candidate of Object.keys(matrix[surface]!).sort()) {
      const cell = matrix[surface]![candidate]!;
      if (cell.status === "reject") {
        any = true;
        lines.push(`- **${surface}** / ${candidate}: ${cell.reason}`);
      }
    }
  }
  if (!any)
    lines.push("none — no candidate was rejected on any measured surface");
  return lines.join("\n");
}

function sectionNoCandidate(
  matrix: Record<string, Record<string, VerdictCell>>,
): string {
  const lines = ["## Surfaces no candidate should take", ""];
  let any = false;
  for (const surface of Object.keys(matrix).sort()) {
    const cells = Object.values(matrix[surface]!);
    if (cells.length > 0 && cells.every((c) => c.status !== "clear")) {
      any = true;
      lines.push(`- **${surface}**: no candidate cleared every gate`);
    }
  }
  if (!any)
    lines.push("none — every surface has at least one clearing candidate");
  return lines.join("\n");
}

function sectionDiscrimination(scores: CaseScore[]): string {
  const lines = ["## Case discrimination", ""];
  for (const s of scores) {
    const note = s.discriminating
      ? ""
      : " — non-discriminating — cannot inform a routing decision";
    lines.push(
      `- ${s.caseId} (${s.arm}): spread ${s.spread.toFixed(3)}${note}`,
    );
  }
  if (scores.length === 0) lines.push("none — no cases scored");
  return lines.join("\n");
}

function sectionSchemaTax(tax: Record<string, SchemaTaxResult>): string {
  const lines = ["## Schema tax", ""];
  for (const model of Object.keys(tax).sort()) {
    const t = tax[model]!;
    const note =
      t.recommendedArm === "free-form"
        ? "route without --json-schema; use flow's local parse-and-validate fallback"
        : "route with --json-schema (wire-level constrained decoding)";
    lines.push(
      `- ${model}: overall tax ${t.overall.toFixed(3)} — recommended arm: ${t.recommendedArm} (${note})`,
    );
  }
  if (Object.keys(tax).length === 0)
    lines.push("none — no model had both arms scored");
  return lines.join("\n");
}

function sectionProvenance(meta: {
  commit: string;
  repeatTiers: Record<string, number>;
  models: string[];
  incumbent: string;
  agyVersion: string;
  runDate: string;
}): string {
  return [
    "## Run provenance",
    "",
    `- commit: ${meta.commit}`,
    `- agy version: ${meta.agyVersion}`,
    `- models: ${meta.models.join(", ")}`,
    `- incumbent: ${meta.incumbent}`,
    `- run date: ${meta.runDate}`,
    `- repeat tiers: ${JSON.stringify(meta.repeatTiers)}`,
  ].join("\n");
}

function sectionLimitations(scores: CaseScore[]): string {
  const nonDisc = scores
    .filter((s) => !s.discriminating)
    .map((s) => `${s.caseId} (${s.arm})`);
  return [
    "## Limitations",
    "",
    "- Repeat tiers (N=10 on decision-bearing surfaces, N=3 elsewhere) are far below the N>=30 that stable latency percentiles call for; medians are reported but underpowered.",
    "- Planted-defect detection rates are selection-biased toward authorable defects and do not generalise to natural defects; the c2b real-defect control narrows but does not close that gap.",
    "- The incumbent baseline runs claude-sonnet-4-6 under agy's scaffold, not the Claude Code scaffold production uses — scaffold-matched to the candidates, but not production-matched.",
    "- Tokens/usage are descriptive only and never gate a verdict.",
    "- Latency is read from durationSeconds (agy's own model-time reading), never the fanout's pool wall-clock.",
    "- A non-discriminating case contributes no clear verdict for any candidate on that surface.",
    nonDisc.length > 0
      ? `- Non-discriminating this run: ${nonDisc.join(", ")}.`
      : "- Non-discriminating this run: none.",
  ].join("\n");
}

export function renderReport(
  scores: CaseScore[],
  matrix: Record<string, Record<string, VerdictCell>>,
  tax: Record<string, SchemaTaxResult>,
  meta: {
    commit: string;
    repeatTiers: Record<string, number>;
    models: string[];
    incumbent: string;
    agyVersion: string;
    runDate: string;
  },
): string {
  return [
    sectionPerSurfaceVerdicts(matrix),
    sectionWhereWorse(matrix),
    sectionNoCandidate(matrix),
    sectionDiscrimination(scores),
    sectionSchemaTax(tax),
    sectionProvenance(meta),
    sectionLimitations(scores),
  ].join("\n\n");
}
