#!/usr/bin/env bun
/**
 * Port of `_reference/extract.py` + `_reference/aggregate.py` (see
 * docs/eval/review-model-recall/README.md), merged into one module with
 * two subcommands — they are two halves of one scoring pass over the
 * same `runs/` + `judge/` cell directory, and splitting them across
 * files buys nothing.
 *
 * `extract` parses each cell's raw result into a findings list, purely
 * for diagnostic visibility (a JSON parse failure here does NOT gate
 * anything downstream — see `aggregate`).
 *
 * `aggregate` reads the judge outputs and reproduces the shape of the
 * committed ../review-model-recall.json: per-cell recall, per-lens-arm
 * mean/variance, and the separation verdict via BOTH statistics the
 * write-up cites — the conservative heuristic (|delta| > pooled
 * within-arm sd) and the one-sided exact permutation test over all
 * C(12,6)=924 splits (the Python original only computed the heuristic;
 * the permutation test was added by hand for the write-up, so this port
 * adds it here too rather than silently dropping it).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { aggregateArms, type CellStat } from "./score-arms";

const LENSES = [
  "bug-detection",
  "pattern-consistency",
  "test-coverage",
] as const;
const PRS = ["812", "756", "802"] as const;
const ARMS = ["sonnet", "opus"] as const;
const RUNS = [1, 2] as const;

// Design facts about THIS harness that are not derivable from the
// runs/judge cell directory — carried over verbatim from the committed
// measurement (../review-model-recall.md "What was deliberately not
// measured" / "What was and was not changed").
const UNMEASURABLE = [
  {
    lens: "security",
    reason:
      "3 acted findings across the 9 comparable reviews in ~/.flow/telemetry/review-lenses.jsonl — too few to separate two models across three PRs",
    decision: "keep current model (no pin)",
  },
  {
    lens: "performance",
    reason:
      "4 acted findings across the 9 comparable reviews — too few to separate two models across three PRs",
    decision: "keep current model (no pin)",
  },
  {
    lens: "supply-chain",
    reason:
      "0 acted findings across the 9 comparable reviews — nothing to measure recall against",
    decision: "keep current model (no pin)",
  },
];

const SHIPPED_PINS = {
  note: "none. Every models.reviewLenses.<lens> key ships absent; see review-model-recall.md 'What was and was not changed'.",
};

const CELL_FILE = /^(.+)-(\d+)-([a-z0-9]+)-r(\d+)\.json$/;

function usage(): string {
  return [
    "Usage:",
    "  score.ts extract <data-dir>",
    "  score.ts aggregate <data-dir> [--out <file>]",
  ].join("\n");
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pvariance(xs: number[]): number {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

function pstdev(xs: number[]): number {
  return Math.sqrt(pvariance(xs));
}

// Tolerates a fenced ```json block, a fenced ``` block, or a bare
// object embedded in prose — matches the Python original's shrink-from-
// the-end parse strategy so a trailing sentence after the JSON doesn't
// break the parse.
function extractJsonObject(
  text: string,
  requiredKey: string,
): Record<string, unknown> | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map(
    (m) => m[1]!,
  );
  let candidates = fenced;
  if (candidates.length === 0) {
    const i = text.indexOf("{");
    candidates = i >= 0 ? [text.slice(i)] : [];
  }
  for (const c of candidates) {
    for (let end = c.length; end > 0; end--) {
      // A valid JSON object always ends in "}" — skip every non-"}" cutoff
      // without attempting a parse. Without this guard the shrink-by-one
      // loop is O(n^2) on exactly the truncated-cell input this harness
      // expects to hit routinely (a truncated trailing object).
      if (c[end - 1] !== "}") continue;
      try {
        const o = JSON.parse(c.slice(0, end));
        if (o && typeof o === "object" && requiredKey in o) return o;
      } catch {
        // keep shrinking
      }
    }
  }
  return null;
}

interface CellFile {
  result?: string;
  text?: string;
}

function runExtract(dataDir: string): number {
  const runsDir = join(dataDir, "runs");
  const files = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".envelope.json"))
        .sort()
    : [];
  const rows: Array<{
    lens: string;
    pr: string;
    arm: string;
    run: number;
    n: number | null;
    parse_ok: boolean;
    findings: unknown[];
  }> = [];
  for (const f of files) {
    const m = f.match(CELL_FILE);
    if (!m) continue;
    const [, lens, pr, arm, run] = m;
    const d = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as CellFile;
    const txt = d.result || d.text || "";
    const o = extractJsonObject(txt, "findings");
    const findings = o ? (o.findings as unknown[]) : null;
    rows.push({
      lens: lens!,
      pr: pr!,
      arm: arm!,
      run: Number(run),
      n: findings ? findings.length : null,
      parse_ok: findings !== null,
      findings: findings || [],
    });
  }
  const outPath = join(dataDir, "cells.json");
  Bun.write(outPath, JSON.stringify(rows, null, 1));

  const okCount = rows.filter((r) => r.parse_ok).length;
  console.log(`cells parsed: ${okCount}/${rows.length}`);
  const bad = rows
    .filter((r) => !r.parse_ok)
    .map((r) => `${r.lens}/${r.pr}/${r.arm}/r${r.run}`);
  if (bad.length) console.log(`UNPARSED: ${bad.join(", ")}`);
  const lensSet = [...new Set(rows.map((r) => r.lens))].sort();
  for (const lens of lensSet) {
    for (const arm of [...new Set(rows.map((r) => r.arm))].sort()) {
      const ns = rows
        .filter((r) => r.lens === lens && r.arm === arm && r.parse_ok)
        .map((r) => r.n);
      console.log(
        `  ${lens.padEnd(22)} ${arm.padEnd(7)} findings/run: [${ns.join(", ")}]`,
      );
    }
  }
  return 0;
}

interface JudgeOutput {
  matches: Array<{ ref: number; category: string | null }>;
  candidate_total?: number;
  new_findings?: number;
}

function costUsdIn(dir: string): number {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const f of readdirSync(dir)) {
    if (
      !f.endsWith(".json") ||
      f.endsWith(".envelope.json") ||
      f.endsWith(".prompt.txt")
    )
      continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        total_cost_usd?: number;
      };
      if (typeof d.total_cost_usd === "number") total += d.total_cost_usd;
    } catch {
      // not a parseable envelope — skip for cost purposes
    }
  }
  return total;
}

// All C(12,6)=924 ways to pick 6 of 12 indices — small enough to
// enumerate directly rather than sampling.
function combinations(n: number, k: number): number[][] {
  const result: number[][] = [];
  const combo: number[] = [];
  function go(start: number) {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < n; i++) {
      combo.push(i);
      go(i + 1);
      combo.pop();
    }
  }
  go(0);
  return result;
}

// One-sided: tests whether the SECOND group's mean exceeds the FIRST's
// (sonnet -> opus for the committed pair).
function exactPermutationP(
  sonnetRecalls: number[],
  opusRecalls: number[],
): number {
  const combined = [...sonnetRecalls, ...opusRecalls];
  const n = combined.length;
  const k = opusRecalls.length;
  const observed = mean(opusRecalls) - mean(sonnetRecalls);
  const splits = combinations(n, k);
  let count = 0;
  for (const idxs of splits) {
    const idxSet = new Set(idxs);
    const group = combined.filter((_, i) => idxSet.has(i));
    const rest = combined.filter((_, i) => !idxSet.has(i));
    const diff = mean(group) - mean(rest);
    if (diff >= observed - 1e-9) count++;
  }
  return count / splits.length;
}

// Resolved model id of a review cell: the dominant non-haiku `modelUsage`
// key of runs/<cell>.json. The `.envelope.json` echoes the CLI alias
// (`fable`/`opus`), so only these dated canonical ids prove which model ran;
// the auxiliary haiku id is ignored.
function resolvedModelId(modelUsage: unknown): string | null {
  if (typeof modelUsage !== "object" || modelUsage === null) return null;
  let best: string | null = null;
  let bestWeight = -Infinity;
  for (const [id, raw] of Object.entries(modelUsage)) {
    if (id.toLowerCase().includes("haiku")) continue;
    const u = (raw ?? {}) as Record<string, unknown>;
    const weight =
      numOrNull(u.costUSD) ??
      (numOrNull(u.inputTokens) ?? 0) + (numOrNull(u.outputTokens) ?? 0);
    if (weight > bestWeight) {
      best = id;
      bestWeight = weight;
    }
  }
  return best;
}

// Per-PR recall spread and a one-sided exact permutation test for any two
// judged arms other than the committed pair. Baseline is opus when present,
// else the alphabetically first arm; p tests "candidate exceeds baseline".
// Keyed by lens like the committed path — pooling lenses would both confound
// recall levels and blow up the C(n,k) split count.
function twoArmSeparation(cells: CellStat[]) {
  const names = [...new Set(cells.map((c) => c.arm))].sort();
  if (names.length !== 2) return null;
  const baseline = names.includes("opus") ? "opus" : names[0]!;
  const candidate = names.find((n) => n !== baseline)!;
  const perPr: Record<string, Record<string, Record<string, unknown>>> = {};
  const separation: Record<string, unknown> = {};
  for (const lens of [...new Set(cells.map((c) => c.lens))].sort()) {
    const recalls: Record<string, number[]> = {};
    for (const arm of names) {
      const mine = cells.filter((c) => c.lens === lens && c.arm === arm);
      recalls[arm] = mine.map((c) => c.recallAll);
      const prs: Record<string, unknown> = {};
      for (const pr of [...new Set(mine.map((c) => c.pr))].sort()) {
        const rs = mine
          .filter((c) => c.pr === pr)
          .sort((a, b) => a.run - b.run)
          .map((c) => c.recallAll);
        prs[`pr-${pr}`] = {
          runs: rs.map((x) => round(x, 4)),
          mean_recall: round(mean(rs), 4),
          variance: round(pvariance(rs), 6),
        };
      }
      (perPr[arm] ??= {})[lens] = prs;
    }
    const b = recalls[baseline]!;
    const c = recalls[candidate]!;
    if (!b.length || !c.length) continue;
    const pooled = Math.sqrt((pstdev(b) ** 2 + pstdev(c) ** 2) / 2);
    separation[lens] = {
      baseline,
      candidate,
      delta_mean_recall: round(mean(c) - mean(b), 4),
      pooled_within_arm_sd: round(pooled, 4),
      exact_permutation_p_one_sided:
        b.length + c.length <= 20 ? round(exactPermutationP(b, c), 4) : null,
    };
  }
  return { perPr, separation };
}

function runCommittedAggregate(
  dataDir: string,
  outFile: string | undefined,
): number {
  const refCounts: Record<string, number> = {};
  for (const pr of PRS) {
    const refs = JSON.parse(
      readFileSync(join(dataDir, `ref-${pr}.json`), "utf8"),
    ) as unknown[];
    refCounts[pr] = refs.length;
  }

  type Cell = {
    matched: number;
    ref: number;
    recall: number;
    same: number;
    equiv: number;
    total: number;
    new: number;
  };
  const cells = new Map<string, Cell>();
  const bad: string[] = [];
  for (const lens of LENSES) {
    for (const pr of PRS) {
      for (const arm of ARMS) {
        for (const run of RUNS) {
          const key = `${lens}|${pr}|${arm}|${run}`;
          const path = join(
            dataDir,
            "judge",
            `${lens}-${pr}-${arm}-r${run}.json`,
          );
          let o: JudgeOutput | null = null;
          if (existsSync(path) && statSync(path).size > 0) {
            const d = JSON.parse(readFileSync(path, "utf8")) as {
              result?: string;
            };
            o = extractJsonObject(
              d.result || "",
              "matches",
            ) as unknown as JudgeOutput | null;
          }
          if (!o) {
            bad.push(`${lens}-${pr}-${arm}-r${run}`);
            continue;
          }
          const matches = o.matches.filter((m) => m.category);
          const ref = refCounts[pr]!;
          cells.set(key, {
            matched: matches.length,
            ref,
            recall: matches.length / ref,
            same: matches.filter((m) => m.category === "same-text").length,
            equiv: matches.filter(
              (m) => m.category === "semantically-equivalent",
            ).length,
            total: o.candidate_total ?? 0,
            new: o.new_findings ?? 0,
          });
        }
      }
    }
  }
  if (bad.length) console.error(`UNPARSED JUDGES: ${bad.join(", ")}`);

  // raw (unrounded) per-lens-per-arm recall arrays, kept alongside the
  // rounded arms[] output so the separation stats below operate on full
  // precision rather than the display-rounded figures.
  const rawRecallsByLensArm = new Map<string, number[]>();

  const arms = ARMS.map((arm) => {
    const lenses: Record<string, unknown> = {};
    const lensAggregates: Record<string, unknown> = {};
    for (const lens of LENSES) {
      const perPr: Record<string, unknown> = {};
      const allRecalls: number[] = [];
      let matchedTotal = 0,
        refTotal = 0,
        candidateTotal = 0,
        newTotal = 0,
        sameTotal = 0,
        equivTotal = 0;
      for (const pr of PRS) {
        const prRawRecalls: number[] = [];
        const runs = RUNS.map((run) => {
          const c = cells.get(`${lens}|${pr}|${arm}|${run}`);
          if (!c) throw new Error(`missing cell ${lens}/${pr}/${arm}/r${run}`);
          allRecalls.push(c.recall);
          prRawRecalls.push(c.recall);
          matchedTotal += c.matched;
          refTotal += c.ref;
          candidateTotal += c.total;
          newTotal += c.new;
          sameTotal += c.same;
          equivTotal += c.equiv;
          return {
            run,
            recall: round(c.recall, 4),
            matched: c.matched,
            reference_findings: c.ref,
            same_text: c.same,
            semantically_equivalent: c.equiv,
            candidate_findings: c.total,
            new_findings: c.new,
          };
        });
        perPr[`pr-${pr}`] = {
          runs,
          mean_recall: round(mean(prRawRecalls), 4),
          variance: round(pvariance(prRawRecalls), 6),
        };
      }
      lenses[lens] = perPr;
      lensAggregates[lens] = {
        mean_recall: round(mean(allRecalls), 4),
        sd_recall: round(pstdev(allRecalls), 4),
        matched_total: matchedTotal,
        reference_total: refTotal,
        candidate_findings_total: candidateTotal,
        new_findings_total: newTotal,
        same_text_total: sameTotal,
        semantically_equivalent_total: equivTotal,
      };
      rawRecallsByLensArm.set(`${lens}|${arm}`, allRecalls);
    }
    return {
      model: arm,
      effort: "medium",
      lenses,
      lens_aggregates: lensAggregates,
    };
  });

  const separation: Record<string, unknown> = {};
  for (const lens of LENSES) {
    const sonnetRecalls = rawRecallsByLensArm.get(`${lens}|sonnet`)!;
    const opusRecalls = rawRecallsByLensArm.get(`${lens}|opus`)!;
    const sonnetMean = mean(sonnetRecalls);
    const opusMean = mean(opusRecalls);
    const sonnetSd = pstdev(sonnetRecalls);
    const opusSd = pstdev(opusRecalls);
    const delta = opusMean - sonnetMean;
    const pooled = Math.sqrt((sonnetSd ** 2 + opusSd ** 2) / 2);
    const separates = pooled > 0 && Math.abs(delta) > pooled;
    const p = exactPermutationP(sonnetRecalls, opusRecalls);
    separation[lens] = {
      delta_mean_recall: round(delta, 4),
      pooled_within_arm_sd: round(pooled, 4),
      exact_permutation_p_one_sided: round(p, 4),
      separates,
      decision: separates ? "pin opus" : "inconclusive — keep current model",
    };
  }

  const prs = PRS.map((pr) => ({
    pr: Number(pr),
    reference_findings: refCounts[pr],
  }));
  const reviewCost = costUsdIn(join(dataDir, "runs"));
  const judgingCost = costUsdIn(join(dataDir, "judge"));

  const out = {
    schema: "flow/review-model-recall@1",
    measured_at: new Date().toISOString().slice(0, 10),
    repo: "flow",
    harness:
      "docs/eval/review-model-recall/ (one-off; each cell is a single review lens re-run over a merged PR's diff via flow-claude-headless, scored by a blinded fixed-model judge)",
    prs,
    runs_per_cell: RUNS.length,
    cost_usd: {
      review_runs: round(reviewCost, 2),
      judging: round(judgingCost, 2),
      total: round(reviewCost + judgingCost, 2),
    },
    arms,
    separation,
    unmeasurable: UNMEASURABLE,
    shipped_pins: SHIPPED_PINS,
  };

  const json = JSON.stringify(out, null, 2);
  if (outFile) {
    Bun.write(outFile, json);
  } else {
    process.stdout.write(json + "\n");
  }
  return 0;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Cost/turns/wall-clock come from the cell's claude JSON (runs/<cell>.json),
// falling back to the wrapper's .envelope.json when the out file lacks them.
function cellMetrics(runsDir: string, base: string) {
  const out = readJson(join(runsDir, `${base}.json`)) ?? {};
  const env = readJson(join(runsDir, `${base}.envelope.json`)) ?? {};
  const pick = (k: string) => numOrNull(out[k]) ?? numOrNull(env[k]);
  return {
    cost: pick("total_cost_usd"),
    turns: pick("num_turns"),
    duration: pick("duration_ms"),
  };
}

function judgedArms(dataDir: string): string[] {
  const dir = join(dataDir, "judge");
  const arms = new Set<string>();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const m = f.match(CELL_FILE);
    if (m && !f.endsWith(".envelope.json")) arms.add(m[3]!);
  }
  return [...arms];
}

function runArmsAggregate(
  dataDir: string,
  outFile: string | undefined,
): number {
  const judgeDir = join(dataDir, "judge");
  const cells: CellStat[] = [];
  const modelIds = new Map<string, Set<string>>();
  const bad: string[] = [];
  for (const f of readdirSync(judgeDir).sort()) {
    const m = f.match(CELL_FILE);
    if (!m || f.endsWith(".envelope.json") || f.endsWith(".prompt.json"))
      continue;
    const [, lens, pr, arm, run] = m;
    const base = f.replace(/\.json$/, "");
    const d = readJson(join(judgeDir, f));
    const o = d
      ? (extractJsonObject(
          String(d.result ?? ""),
          "matches",
        ) as unknown as JudgeOutput | null)
      : null;
    if (!o) {
      bad.push(base);
      continue;
    }
    const refs = JSON.parse(
      readFileSync(join(dataDir, `ref-${pr}.json`), "utf8"),
    ) as unknown[];
    const actedPath = join(dataDir, `ref-acted-${pr}.json`);
    const acted = new Set<number>(
      existsSync(actedPath)
        ? (JSON.parse(readFileSync(actedPath, "utf8")) as number[])
        : [],
    );
    const runOut = readJson(join(dataDir, "runs", `${base}.json`));
    const id = resolvedModelId(runOut?.modelUsage);
    if (id) {
      if (!modelIds.has(arm!)) modelIds.set(arm!, new Set());
      modelIds.get(arm!)!.add(id);
    }
    const matched = o.matches.filter((x) => x.category);
    const matchedActed = matched.filter((x) => acted.has(x.ref)).length;
    cells.push({
      lens: lens!,
      pr: pr!,
      arm: arm!,
      run: Number(run),
      ...cellMetrics(join(dataDir, "runs"), base),
      recallAll: refs.length ? matched.length / refs.length : 0,
      recallActed: acted.size ? matchedActed / acted.size : null,
      candidates: o.candidate_total ?? 0,
    });
  }
  if (bad.length) console.error(`UNPARSED JUDGES: ${bad.join(", ")}`);
  const agg = aggregateArms(cells);
  const two = twoArmSeparation(cells);
  const arms = Object.fromEntries(
    Object.entries(agg.arms).map(([name, stats]) => [
      name,
      {
        ...stats,
        resolved_model_ids: [...(modelIds.get(name) ?? [])].sort(),
        ...(two ? { per_pr: two.perPr[name] } : {}),
      },
    ]),
  );
  const json = JSON.stringify(
    {
      schema: "flow/review-arms-recall@1",
      measured_at: new Date().toISOString().slice(0, 10),
      arms,
      ...(two ? { separation: two.separation } : {}),
    },
    null,
    2,
  );
  if (outFile) Bun.write(outFile, json);
  else process.stdout.write(json + "\n");
  return 0;
}

function runAggregate(dataDir: string, outFile: string | undefined): number {
  const arms = judgedArms(dataDir).sort().join(",");
  if (arms !== "opus,sonnet") return runArmsAggregate(dataDir, outFile);
  return runCommittedAggregate(dataDir, outFile);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(usage());
    process.exit(sub ? 0 : 2);
  }
  if (sub === "extract") {
    const dataDir = argv[1];
    if (!dataDir) {
      console.error(usage());
      process.exit(2);
    }
    process.exit(runExtract(dataDir));
  } else if (sub === "aggregate") {
    const dataDir = argv[1];
    if (!dataDir) {
      console.error(usage());
      process.exit(2);
    }
    const outFlagIdx = argv.indexOf("--out");
    const outFile = outFlagIdx !== -1 ? argv[outFlagIdx + 1] : undefined;
    process.exit(runAggregate(dataDir, outFile));
  } else {
    console.error(usage());
    process.exit(2);
  }
}

export {
  CELL_FILE,
  extractJsonObject,
  exactPermutationP,
  combinations,
  pstdev,
  pvariance,
  mean,
  round,
  resolvedModelId,
  twoArmSeparation,
};
