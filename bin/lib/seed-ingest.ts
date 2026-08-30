/**
 * Self-describing seed-integrity record shared by the seed-ingested hook (the
 * producer) and every launcher consumer (`feature.ts`, `epic.ts`,
 * `launcher.ts`). It replaces the two-boolean-ish `seedIngestedAt` /
 * `seedMismatch` pair, whose absent state was ambiguous: "not yet ingested"
 * and "ingested but unverifiable" looked identical, so an unverified delivery
 * could masquerade as a verified one.
 *
 * FIVE real outcomes — four encoded here plus one encoded by ABSENCE:
 *
 * - `verified` — the submitted prompt contained the recorded seed intact.
 * - `unverified` — a prompt was accepted but the hook could not compare it
 *   (stdin timed out / errored, payload unparsable, or no `prompt` field).
 *   Explicitly NOT a success: consumers must fall through to their
 *   pre-existing phase/updatedAt signal rather than latching consumption.
 * - `not-applicable` — no seed was recorded for this launch (the plain
 *   backend records none), so there is nothing to verify.
 * - `corrupt` — a delivery carrying the seed's leading-line marker arrived
 *   without the seed intact: a truncated/garbled delivery. Carries both byte
 *   counts so the CLI can report the size of the loss.
 * - ABSENT (no `seedIngest` field at all) — not yet ingested. This is the
 *   fifth outcome and is deliberately not spelled as a variant: a state file
 *   written before the first prompt simply has no record.
 *
 * MONOTONE LATCH (enforced by the hook, documented here because every
 * consumer's predicate ordering depends on it):
 *
 * - `unverified` may be replaced by `corrupt` or `verified`.
 * - `corrupt` may be replaced ONLY by `verified` — this is what preserves
 *   PR #686's clear-on-intact-retry, where a corrupted attempt 1 followed by
 *   an intact attempt 2 must not stay latched as failed.
 * - `verified` and `not-applicable` are terminal for their epoch.
 * - A resume path that clears `seedIngest` back to `undefined` starts a NEW
 *   epoch; the latch rules apply within an epoch, never across one.
 */
export type SeedIngest =
  | { at: string; outcome: "verified" }
  | { at: string; outcome: "not-applicable"; reason: "no-seed-recorded" }
  | {
      at: string;
      outcome: "unverified";
      reason:
        | "stdin-timeout"
        | "stdin-error"
        | "payload-unparsable"
        | "no-prompt-field";
    }
  | {
      at: string;
      outcome: "corrupt";
      expectedBytes: number;
      submittedBytes: number;
    };

/** Structural guard for `isPipelineState`'s optional-field check. */
export function isSeedIngest(v: unknown): v is SeedIngest {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "string") return false;
  switch (o.outcome) {
    case "verified":
      return true;
    case "not-applicable":
    case "unverified":
      return typeof o.reason === "string";
    case "corrupt":
      return (
        typeof o.expectedBytes === "number" &&
        typeof o.submittedBytes === "number"
      );
    default:
      return false;
  }
}

/**
 * Structural param, NOT `PipelineState`: `state.ts` imports FROM this module,
 * so naming `PipelineState` here would create an import cycle. Same for the
 * two predicates below.
 */
export function seedIngestIsCorrupt(
  s: { seedIngest?: SeedIngest } | null | undefined,
): boolean {
  return s?.seedIngest?.outcome === "corrupt";
}

export function seedIngestConfirmsDelivery(
  s: { seedIngest?: SeedIngest } | null | undefined,
): boolean {
  return s?.seedIngest?.outcome === "verified";
}

/**
 * ONE definition, four call sites (`flow feature create` / `flow feature
 * resume` / `flow epic create` / `flow epic create --resume`), so the wording
 * cannot drift. Returns null on every outcome except `unverified`.
 */
export function unverifiedSeedWarning(
  command: string,
  s: { seedIngest?: SeedIngest } | null | undefined,
): string | null {
  const rec = s?.seedIngest;
  if (rec?.outcome !== "unverified") return null;
  return `${command}: seed integrity NOT verified (${rec.reason}) — confirm the window's first prompt is the request you typed.`;
}
