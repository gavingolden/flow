/**
 * Slug normalization for tmux window names + state-file basenames.
 *
 * Slugs are derived once at `flow feature create` time and never renamed (rename in a
 * parallel-pipeline world adds collision hazards the supervisor is trying to
 * reduce). The supervisor takes the slug as final.
 *
 * Pipeline:
 *   1. Lowercase, replace non-alphanumeric runs with `-`.
 *   2. Drop English stop-words from the token list.
 *   3. Cap at MAX_TOKENS tokens (kebab "words"), then 40-char overall.
 *   4. If filtering yields nothing, fall back to `task-<sha256[0..8]>` so
 *      `flow feature create` never refuses with "produces an empty slug".
 */

import { createHash } from "node:crypto";

const MAX_LENGTH = 40;
const MAX_TOKENS = 5;

/**
 * Max length for an explicit `--slug` value. Roomier than slugify's 40-char
 * derivation cap because an epic id-derived slug or a deliberate human slug may
 * legitimately run longer, and the tmux-window / state-file / branch sinks all
 * tolerate it.
 */
const MAX_SLUG_LENGTH = 60;

/**
 * Canonical slug-legality check — the single source of truth for whether a
 * string is a valid pipeline slug (tmux window name, `<slug>.json` state-file
 * basename, git branch / worktree-dir suffix). Enforces lowercase kebab-case
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$`: no leading/trailing/double hyphens, no
 * uppercase or spaces) plus a MAX_SLUG_LENGTH bound.
 *
 * Deliberately NOT `slugify(s) === s`: slugify caps at MAX_TOKENS/MAX_LENGTH, so
 * a legitimately longer explicit slug would round-trip to a shorter string and
 * be wrongly rejected. Validate by shape + length only.
 */
export function isValidSlug(s: string): boolean {
  if (s.length === 0 || s.length > MAX_SLUG_LENGTH) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "if",
  "with",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "that",
  "this",
  "it",
  "its",
]);

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  if (!trimmed) return fallbackSlug(input);

  const tokens = trimmed.split("-");
  const filtered = tokens.filter((t) => !STOP_WORDS.has(t));
  if (filtered.length === 0) return fallbackSlug(input);

  const capped = filtered.slice(0, MAX_TOKENS);
  return capped.join("-").slice(0, MAX_LENGTH).replace(/-+$/g, "");
}

function fallbackSlug(input: string): string {
  const hash = createHash("sha256")
    .update(input.toLowerCase())
    .digest("hex")
    .slice(0, 8);
  return `task-${hash}`;
}
