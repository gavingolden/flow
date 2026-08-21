const MAX_LEN = 20;

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Planted defect (evals/verify-loop-isolation/s1-single-fix): off-by-one
  // truncation — fails exactly "truncates at the max length" in
  // src/slug.test.ts, leaving the other two tests green.
  return dashed.slice(0, MAX_LEN - 1);
}
