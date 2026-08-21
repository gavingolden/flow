const MAX_LEN = 20;

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return dashed.slice(0, MAX_LEN);
}
