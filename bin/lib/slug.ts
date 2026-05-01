/**
 * Slug normalization for tmux window names + state-file basenames.
 *
 * Rules: lowercase, replace any non-alphanumeric run with a single `-`, trim
 * leading/trailing `-`, cap at 40 chars. The same description always maps
 * to the same slug — collision policy ("refuse on existing window") lives
 * in the caller, not here.
 */

const MAX_LENGTH = 40;

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, MAX_LENGTH).replace(/-+$/g, "");
}
