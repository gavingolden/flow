/**
 * `--report` mode for `flow-model-bench`: joins a completed run's
 * results.json against the fixture truths (and an optional blind-judge
 * verdicts file) and writes report.md + verdicts.json via the scorer.
 * Split out of `bin/flow-model-bench.ts` to keep that file under its line
 * budget — same non-PATH-bound precedent as `bin/lib/model-bench-schema.ts`
 * and `bin/lib/model-bench-manifest.ts`.
 *
 * Deliberately dispatches NO model call and calls neither `runFanout` nor
 * `preflight` — this module never imports flow-delegate-fanout.
 */

import { join } from "node:path";
import {
  validateResults,
  validateTruth,
  type BenchSurface,
} from "./model-bench-schema";
import { loadCases } from "./model-bench-manifest";
import {
  scoreCase,
  schemaTax,
  verdict,
  recommend,
  renderReport,
  type CaseScore,
} from "./model-bench-score";

export type ReportDeps = {
  readFile: (p: string) => string;
  writeFile: (p: string, data: string) => void;
  fileExists: (p: string) => boolean;
  mkdirp: (d: string) => void;
  readdir: (d: string) => string[];
  progress: (line: string) => void;
  gitHead: () => string;
  agyVersion: () => string;
  runDate: (resultsPath: string) => string;
};

export type ReportArgs = {
  fixturesDir: string;
  out: string;
  judgedFile?: string;
  incumbent: string;
  schemaTaxThreshold: number;
};

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Translates a blind-judge verdicts file (keyed by judge-packet ids) into
// verdict()'s `${surface}::${candidate}` keying, via judge-key.json (id ->
// model) and judge-packet.json (id -> caseId -> surface). Returns undefined
// (with a progress line already emitted) on any missing/malformed input.
function translateJudged(
  args: ReportArgs,
  deps: ReportDeps,
  caseSurfaces: Record<string, BenchSurface>,
): Record<string, "worse" | "parity" | "better"> | undefined {
  const keyPath = join(args.out, "judge-key.json");
  const packetPath = join(args.out, "judge-packet.json");
  if (!deps.fileExists(keyPath) || !deps.fileExists(packetPath)) {
    deps.progress(
      `flow-model-bench: --judged requires ${keyPath} and ${packetPath} from the prior run\n`,
    );
    return undefined;
  }
  try {
    const key = JSON.parse(deps.readFile(keyPath)) as Record<string, string>;
    const packet = JSON.parse(deps.readFile(packetPath)) as Array<{
      id: string;
      caseId: string;
    }>;
    const packetById = new Map(packet.map((p) => [p.id, p]));
    const judgedRaw = JSON.parse(deps.readFile(args.judgedFile!)) as Record<
      string,
      "worse" | "parity" | "better"
    >;
    const result: Record<string, "worse" | "parity" | "better"> = {};
    for (const [blindedId, verdictValue] of Object.entries(judgedRaw)) {
      const model = key[blindedId];
      const entry = packetById.get(blindedId);
      if (!model || !entry) continue;
      const surface = caseSurfaces[entry.caseId];
      if (!surface) continue;
      result[`${surface}::${model}`] = verdictValue;
    }
    return result;
  } catch (err) {
    deps.progress(
      `flow-model-bench: --judged file ${args.judgedFile}: not valid JSON: ${(err as Error).message}\n`,
    );
    return undefined;
  }
}

export function runReport(args: ReportArgs, deps: ReportDeps): number {
  const resultsPath = join(args.out, "results.json");
  if (!deps.fileExists(resultsPath)) {
    deps.progress(
      `flow-model-bench: --report requires ${resultsPath} from a prior run\n`,
    );
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFile(resultsPath));
  } catch (err) {
    deps.progress(
      `flow-model-bench: ${resultsPath}: not valid JSON: ${(err as Error).message}\n`,
    );
    return 2;
  }
  const validated = validateResults(parsed);
  if (!validated.ok) {
    deps.progress(`flow-model-bench: ${resultsPath}: ${validated.reason}\n`);
    return 2;
  }
  const results = validated.value;

  const cases = loadCases(args.fixturesDir, deps);
  if ("error" in cases) {
    deps.progress(`flow-model-bench: ${cases.error}\n`);
    return 2;
  }

  const caseSurfaces: Record<string, BenchSurface> = {};
  const repeatTiers: Record<string, number> = {};
  const scores: CaseScore[] = [];
  for (const c of cases) {
    caseSurfaces[c.id] = c.surface;
    repeatTiers[c.id] = c.repeats ?? 1;
    const truthPath = join(args.fixturesDir, c.id, "truth.json");
    if (!deps.fileExists(truthPath)) continue;
    let truthParsed: unknown;
    try {
      truthParsed = JSON.parse(deps.readFile(truthPath));
    } catch (err) {
      deps.progress(
        `flow-model-bench: ${truthPath}: not valid JSON: ${(err as Error).message}\n`,
      );
      return 2;
    }
    const truthResult = validateTruth(truthParsed);
    if (!truthResult.ok) {
      deps.progress(`flow-model-bench: ${truthPath}: ${truthResult.reason}\n`);
      return 2;
    }
    scores.push(...scoreCase(results, truthResult.value));
  }

  const models = [...new Set(results.map((r) => r.model))];
  const candidates = models.filter((m) => m !== args.incumbent);

  let judged: Record<string, "worse" | "parity" | "better"> | undefined;
  if (args.judgedFile) {
    judged = translateJudged(args, deps, caseSurfaces);
    if (judged === undefined) return 2;
  }

  const tax = schemaTax(scores, args.schemaTaxThreshold);
  const matrix = verdict(scores, {
    incumbent: args.incumbent,
    candidates,
    judged,
    caseSurfaces,
  });
  const recommendation = recommend(matrix, scores, caseSurfaces);

  const meta = {
    commit: safeCall(deps.gitHead, "unknown"),
    repeatTiers,
    models,
    incumbent: args.incumbent,
    agyVersion: safeCall(deps.agyVersion, "unknown"),
    runDate: safeCall(
      () => deps.runDate(resultsPath),
      new Date().toISOString().slice(0, 10),
    ),
  };

  const report = renderReport(scores, matrix, tax, meta);
  deps.writeFile(join(args.out, "report.md"), report);
  deps.writeFile(
    join(args.out, "verdicts.json"),
    JSON.stringify({ matrix, recommendation, tax }, null, 2),
  );
  deps.progress(
    `flow-model-bench: wrote report.md and verdicts.json to ${args.out}\n`,
  );
  return 0;
}
