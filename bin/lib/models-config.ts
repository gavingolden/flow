/**
 * Tolerant boundary reader for `~/.flow/config.json`'s `models` table.
 *
 * Mirrors `copilot-config.ts` / `epic-config.ts`: reads the same
 * `~/.flow/config.json` off `flowConfigPath()` through an injectable
 * `ReadConfigFile` seam (so tests never touch the real file), and collapses
 * anything unreadable / malformed / wrong-typed / out-of-enum to `undefined`.
 *
 * Unlike the epic readers, these return `undefined` (not a built-in default) —
 * the precedence chain is owned by the caller: `--model-<phase>` flag (state
 * field) `//` `config.models.<phase>` `//` inherited session model, with the
 * verify-`sonnet` and scout/coder fine-grain exceptions applied at their spawn
 * sites. The `default` key (whole-session default, consumed at launch by
 * `feature.ts` / `epic.ts`) is read by `readDefaultModel`.
 *
 * `MODEL_ALIASES` is reused verbatim from `state.ts` — do NOT re-declare it
 * here; a second copy would violate the single-source-of-truth the Task
 * `model:` enum depends on.
 */

import * as fs from "node:fs";
import { flowConfigPath } from "./paths";
import { MODEL_ALIASES, type ModelAlias } from "./state";

/**
 * Config-read seam. Returns the raw parsed JSON, or `undefined` when the file
 * is absent/unreadable/non-JSON. Tests override this so the real
 * `~/.flow/config.json` is never read.
 */
export type ReadConfigFile = () => unknown;

export const defaultReadConfigFile: ReadConfigFile = () => {
  try {
    return JSON.parse(fs.readFileSync(flowConfigPath(), "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Wrap a `ReadConfigFile` so the underlying read + parse happens at most once,
 * no matter how many times the returned closure is called. Every call site
 * that needs `~/.flow/config.json` more than once per invocation (a
 * multi-row audit table, or a launch path reading both `models.*` and
 * `launch.*`) should share one of these rather than re-reading/re-parsing
 * the file per call.
 */
export function cachedConfigRead(base: ReadConfigFile): ReadConfigFile {
  let cached: unknown;
  let cachedRead = false;
  return () => {
    if (!cachedRead) {
      cached = base();
      cachedRead = true;
    }
    return cached;
  };
}

function asModelAlias(v: unknown): ModelAlias | undefined {
  return typeof v === "string" &&
    (MODEL_ALIASES as readonly string[]).includes(v)
    ? (v as ModelAlias)
    : undefined;
}

function extractModelsKey(raw: unknown, key: string): ModelAlias | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const models = (raw as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return undefined;
  return asModelAlias((models as Record<string, unknown>)[key]);
}

/**
 * The seven `models.reviewLenses.<lens>` keys `flow-pr-review` may route on:
 * the six review lenses plus the intent-guess spawn. Exported so the
 * warning text and `model-routing-table.ts`'s per-lens `SPAWN_SITES` rows
 * read off the same list and cannot drift apart.
 */
export const REVIEW_LENS_NAMES = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
  "intent-guess",
] as const;
export type ReviewLensName = (typeof REVIEW_LENS_NAMES)[number];

function extractNestedModelsKey(
  raw: unknown,
  outerKey: string,
  innerKey: string,
): ModelAlias | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const models = (raw as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return undefined;
  const outer = (models as Record<string, unknown>)[outerKey];
  if (typeof outer !== "object" || outer === null) return undefined;
  return asModelAlias((outer as Record<string, unknown>)[innerKey]);
}

/**
 * The configured `models.reviewLenses.<lens>` when it is a valid alias, else
 * `undefined`. Reads the NESTED object directly — it deliberately does NOT go
 * through `extractModelsKey`, whose flat `models[key]` read cannot see a
 * nested object. Same tolerant-boundary discipline as `readPhaseModel`: never
 * throws, any missing/corrupt/wrong-shaped config collapses to `undefined`.
 */
export function readReviewLensModel(
  lens: string,
  read: ReadConfigFile = defaultReadConfigFile,
): ModelAlias | undefined {
  return extractNestedModelsKey(read(), "reviewLenses", lens);
}

/**
 * The configured `models.<phase>` when it is a valid alias, else `undefined`.
 * Never throws — a missing/corrupt config or any non-alias value collapses to
 * `undefined` through the boundary reader's `catch` + the enum guard. The
 * caller applies its own precedence fallback.
 */
export function readPhaseModel(
  phase: string,
  read: ReadConfigFile = defaultReadConfigFile,
): ModelAlias | undefined {
  return extractModelsKey(read(), phase);
}

/**
 * The configured whole-session default `models.default` when it is a valid
 * alias, else `undefined`. Consumed at launch by `feature.ts` / `epic.ts` as
 * the `--model` fallback (the flag, when present, wins). Never throws.
 */
export function readDefaultModel(
  read: ReadConfigFile = defaultReadConfigFile,
): ModelAlias | undefined {
  return extractModelsKey(read(), "default");
}

/**
 * Best-effort, non-fatal warnings for any `models.<key>` that is present but
 * not a valid alias (default or per-phase). Callers print these to stderr at
 * create time then fall back — a present-but-invalid config value silently
 * collapsing to `undefined` would otherwise be an easy foot-gun. Never throws;
 * an unreadable or malformed config yields an empty list.
 */
export function collectModelConfigWarnings(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] {
  const raw = read();
  if (typeof raw !== "object" || raw === null) return [];
  const models = (raw as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return [];
  const modelsObj = models as Record<string, unknown>;
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(modelsObj)) {
    if (value === undefined) continue;
    // `reviewLenses` is a nested object, not a flat alias — walked separately
    // below. Without this skip every `flow feature create` would emit a
    // spurious "'[object Object]' is not a valid model alias" line.
    if (key === "reviewLenses") continue;
    if (asModelAlias(value) === undefined) {
      warnings.push(
        `models.${key}: '${String(value)}' is not a valid model alias ` +
          `(expected one of: ${MODEL_ALIASES.join(", ")}); ignoring.`,
      );
    }
  }
  warnings.push(...collectReviewLensWarnings(modelsObj.reviewLenses));
  return warnings;
}

/**
 * Warnings for `models.reviewLenses`: a non-object value warns naming the
 * expected shape; a key outside `REVIEW_LENS_NAMES` warns as an unknown
 * lens; a recognised lens with a non-alias value warns naming the full
 * dotted key. Absent `reviewLenses` yields no warnings.
 */
function collectReviewLensWarnings(reviewLenses: unknown): string[] {
  if (reviewLenses === undefined) return [];
  if (typeof reviewLenses !== "object" || reviewLenses === null) {
    return [
      "models.reviewLenses: expected an object mapping lens name to model " +
        "alias; ignoring.",
    ];
  }
  const warnings: string[] = [];
  for (const [lens, value] of Object.entries(
    reviewLenses as Record<string, unknown>,
  )) {
    if (value === undefined) continue;
    if (!(REVIEW_LENS_NAMES as readonly string[]).includes(lens)) {
      warnings.push(
        `models.reviewLenses.${lens}: unknown review lens ` +
          `(expected one of: ${REVIEW_LENS_NAMES.join(", ")}).`,
      );
      continue;
    }
    if (asModelAlias(value) === undefined) {
      warnings.push(
        `models.reviewLenses.${lens}: '${String(value)}' is not a valid ` +
          `model alias (expected one of: ${MODEL_ALIASES.join(", ")}); ignoring.`,
      );
    }
  }
  return warnings;
}
