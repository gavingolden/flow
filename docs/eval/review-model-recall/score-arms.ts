/**
 * Arm-generic aggregation for `score.ts aggregate` — used whenever the judged
 * cells carry arms other than the committed sonnet/opus pair. Pure functions
 * over per-cell stats so they are unit-testable without a judge run. The sonnet/opus path stays in score.ts
 * and keeps the committed ../review-model-recall.json shape.
 */

export type CellStat = {
  lens: string;
  pr: string;
  arm: string;
  run: number;
  cost: number | null;
  turns: number | null;
  duration: number | null;
  recallAll: number;
  recallActed: number | null;
  candidates: number;
};

const mean = (xs: number[]): number =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function pstdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

const nums = (xs: (number | null)[]): number[] =>
  xs.filter((x): x is number => x !== null);

const r = (n: number | null, places = 4): number | null =>
  n === null ? null : Math.round(n * 10 ** places) / 10 ** places;

function armStats(cells: CellStat[]) {
  const acted = nums(cells.map((c) => c.recallActed));
  const cost = nums(cells.map((c) => c.cost));
  return {
    cells: cells.length,
    cost_usd: {
      median: r(median(cost), 4),
      mean: r(cost.length ? mean(cost) : null, 4),
    },
    num_turns: { median: r(median(nums(cells.map((c) => c.turns))), 2) },
    duration_ms: { median: r(median(nums(cells.map((c) => c.duration))), 0) },
    recall_all: r(mean(cells.map((c) => c.recallAll))),
    recall_acted: r(acted.length ? mean(acted) : null),
    candidate_findings_median: median(cells.map((c) => c.candidates)),
  };
}

export function aggregateArms(cells: CellStat[]) {
  const names = [...new Set(cells.map((c) => c.arm))].sort();
  return {
    arms: Object.fromEntries(
      names.map((a) => [a, armStats(cells.filter((c) => c.arm === a))]),
    ),
  };
}
