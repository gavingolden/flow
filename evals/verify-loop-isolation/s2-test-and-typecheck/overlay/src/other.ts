export function double(n: number): number {
  return n * 2;
}

// Planted defect (evals/verify-loop-isolation/s2-test-and-typecheck): a
// type error — assigning a string literal where `number` is declared —
// so `bun run typecheck` (tsc --noEmit) fails alongside the `bun test`
// failure planted in src/slug.ts, exercising two check classes in one run.
export const doubled: number = "not a number";
