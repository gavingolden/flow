/**
 * Arm-generic aggregation for `score.ts aggregate` — used whenever the judged
 * cells carry arms other than the committed sonnet/opus pair (packed,
 * pointer, ...). Pure functions over per-cell stats so the ship rule is
 * unit-testable without a judge run. The sonnet/opus path stays in score.ts
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

type Verdict = boolean | null;

function perLens(
  cells: CellStat[],
  lens: string,
  pick: (c: CellStat) => number | null,
): { packed: number[]; pointer: number[] } {
  const of = (arm: string) =>
    nums(cells.filter((c) => c.lens === lens && c.arm === arm).map(pick));
  return { packed: of("packed"), pointer: of("pointer") };
}

/** Packed must not trail pointer by more than one pooled within-arm sd on
 * every lens that has data; null when no lens has any. */
function noWorseThanSd(
  cells: CellStat[],
  lenses: string[],
  pick: (c: CellStat) => number | null,
): Verdict {
  let seen = false;
  for (const lens of lenses) {
    const { packed, pointer } = perLens(cells, lens, pick);
    if (packed.length === 0 || pointer.length === 0) continue;
    seen = true;
    const sd = Math.sqrt((pstdev(packed) ** 2 + pstdev(pointer) ** 2) / 2);
    if (mean(packed) - mean(pointer) < -sd - 1e-9) return false;
  }
  return seen ? true : null;
}

export function shipRule(cells: CellStat[]) {
  const packed = cells.filter((c) => c.arm === "packed");
  const pointer = cells.filter((c) => c.arm === "pointer");
  if (packed.length === 0 || pointer.length === 0) return null;
  const lenses = [...new Set(cells.map((c) => c.lens))];
  const med = (cs: CellStat[], f: (c: CellStat) => number | null) =>
    median(nums(cs.map(f)));
  const ratioOk = (f: (c: CellStat) => number | null, max: number): Verdict => {
    const a = med(packed, f);
    const b = med(pointer, f);
    return a === null || b === null || b === 0 ? null : a <= max * b;
  };
  const cost_ok = ratioOk((c) => c.cost, 0.85);
  const wallclock_ok = ratioOk((c) => c.duration, 1.1);
  const recall_acted_ok = noWorseThanSd(cells, lenses, (c) => c.recallActed);
  const findings_ok = noWorseThanSd(cells, lenses, (c) => c.candidates);
  const runsPerCell = new Map<string, number>();
  for (const c of cells) {
    const k = `${c.arm}|${c.lens}|${c.pr}`;
    runsPerCell.set(k, (runsPerCell.get(k) ?? 0) + 1);
  }
  const thin = [...runsPerCell.values()].some((n) => n < 2);
  const parts = [cost_ok, recall_acted_ok, findings_ok, wallclock_ok];
  const pass: boolean | "insufficient" =
    thin || parts.some((p) => p === null)
      ? "insufficient"
      : parts.every(Boolean);
  return { cost_ok, recall_acted_ok, findings_ok, wallclock_ok, pass };
}

export function aggregateArms(cells: CellStat[]) {
  const names = [...new Set(cells.map((c) => c.arm))].sort();
  return {
    arms: Object.fromEntries(
      names.map((a) => [a, armStats(cells.filter((c) => c.arm === a))]),
    ),
    ship_rule: shipRule(cells),
  };
}
