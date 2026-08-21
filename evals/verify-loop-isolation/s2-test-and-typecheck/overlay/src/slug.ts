const MAX_LEN = 20;

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Planted defect (evals/verify-loop-isolation/s2-test-and-typecheck): the
  // same off-by-one truncation as s1's overlay.
  return dashed.slice(0, MAX_LEN - 1);
}
