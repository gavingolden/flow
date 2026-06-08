/**
 * Tolerant boundary reader for `~/.flow/config.json` `bots.copilot`.
 *
 * `bots.copilot` may be EITHER a bare string (legacy: just the reviewer
 * login) OR an object `{ login?, globs?: { alwaysReview?, neverAlone? } }`.
 * Both shapes are valid config — this is validate-at-boundaries, not a
 * back-compat shim. Anything unreadable, malformed, or wrong-typed
 * collapses to the built-in defaults.
 *
 * Consumed by `flow-ci-wait.ts` (login via the `Deps.readCopilotLogin` seam,
 * plus the global `bots.copilotClaimDeadlineSec` via the `Deps.readClaimDeadline`
 * seam) and `flow-request-copilot.ts` (login + merged glob sets).
 */

import * as fs from "node:fs";
import { FLOW_CONFIG } from "./paths";

export const DEFAULT_COPILOT_LOGIN = "copilot-pull-request-reviewer";

/**
 * Suffix-tolerant author-match form: lowercase the base login and strip a
 * trailing `[bot]` so review author-login equality comparisons match
 * whether GitHub reports `copilot-pull-request-reviewer` or
 * `copilot-pull-request-reviewer[bot]`. Idempotent.
 */
export function copilotAuthorMatch(base: string): string {
  return base.toLowerCase().replace(/\[bot\]$/, "");
}

/**
 * The request slug gh's native Copilot-reviewer support expects:
 * `gh pr edit <pr> --add-reviewer @copilot`. Verified against gh 2.88.x on a
 * private personal-account repo — the add-reviewer call succeeds and Copilot
 * lands in `requested_reviewers` as `{login: "Copilot", type: "Bot"}`. This is
 * the REQUEST identity; Copilot's review-AUTHOR identity is the distinct
 * `copilot-pull-request-reviewer` login (see `matchesCopilot`).
 */
export const COPILOT_REQUEST_SLUG = "@copilot";

/** Copilot's two interchangeable bare logins: the `@copilot` slug strips to
 * `copilot`, and `requested_reviewers` / review-author surfaces use
 * `copilot-pull-request-reviewer`. Aliases expand only when the configured
 * base is itself a Copilot login, so a custom bot login never matches them. */
const COPILOT_ALIASES = new Set(["copilot", "copilot-pull-request-reviewer"]);

/**
 * Unified Copilot-identity predicate. Returns true when `login` denotes the
 * same reviewer as `configuredBase`, across all four surfaces Copilot renders
 * under: the `@copilot` request slug (`copilot`), the `requested_reviewers`
 * GET entry (`Copilot`, type Bot), the GraphQL review author
 * (`copilot-pull-request-reviewer`), and the REST review author
 * (`copilot-pull-request-reviewer[bot]`). Both sides are lowercased and have a
 * trailing `[bot]` stripped; if they match directly, true. Otherwise the
 * Copilot aliases expand ONLY when the configured base is itself a Copilot
 * login, so `matchesCopilot("Copilot", "my-bot")` stays false.
 */
export function matchesCopilot(login: string, configuredBase: string): boolean {
  const strippedLogin = copilotAuthorMatch(login);
  const strippedBase = copilotAuthorMatch(configuredBase);
  if (strippedLogin === strippedBase) return true;
  return (
    COPILOT_ALIASES.has(strippedBase) && COPILOT_ALIASES.has(strippedLogin)
  );
}

/** Surfaces that always warrant a review on their own (security/migration/CI/infra). */
export const DEFAULT_ALWAYS_REVIEW_GLOBS = [
  "**/auth/**",
  "supabase/migrations/**",
  ".github/workflows/**",
  "infra/terraform/**",
];

/** Surfaces that, on their own, never warrant a review (generated/lockfile/snapshot/docs). */
export const DEFAULT_NEVER_ALONE_GLOBS = [
  "**/*.gen.*",
  "**/*.snap",
  "docs/**/*.md",
  "package-lock.json",
  "bun.lockb",
];

export type CopilotGlobs = { alwaysReview: string[]; neverAlone: string[] };
export type CopilotConfig = { login: string; globs: CopilotGlobs };

/**
 * Config-read seam. Returns the raw parsed JSON, or `undefined` when the
 * file is absent/unreadable/non-JSON. Tests override this so the real
 * `~/.flow/config.json` is never touched.
 */
export type ReadConfigFile = () => unknown;

const defaultReadConfigFile: ReadConfigFile = () => {
  try {
    return JSON.parse(fs.readFileSync(FLOW_CONFIG, "utf8"));
  } catch {
    return undefined;
  }
};

function extractBotsCopilot(
  raw: unknown,
): string | Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const bots = (raw as Record<string, unknown>).bots;
  if (typeof bots !== "object" || bots === null) return undefined;
  const copilot = (bots as Record<string, unknown>).copilot;
  if (typeof copilot === "string") return copilot;
  if (
    typeof copilot === "object" &&
    copilot !== null &&
    !Array.isArray(copilot)
  ) {
    return copilot as Record<string, unknown>;
  }
  return undefined;
}

function extractBotsCopilotClaimDeadlineSec(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const bots = (raw as Record<string, unknown>).bots;
  if (typeof bots !== "object" || bots === null) return undefined;
  const n = (bots as Record<string, unknown>).copilotClaimDeadlineSec;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

function extractBotsCopilotSkipWait(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const bots = (raw as Record<string, unknown>).bots;
  if (typeof bots !== "object" || bots === null) return false;
  return (bots as Record<string, unknown>).copilotSkipWait === true;
}

/**
 * Tri-state, unlike `extractBotsCopilotSkipWait`: the resolver short-circuits
 * BOTH the authoritative ruleset read and the 5-PR heuristic only on a defined
 * value, so absent/missing-bots/wrong-typed MUST collapse to `undefined` (let
 * auto-detect run) — never to `false` (which would force "not configured" on
 * every unconfigured repo).
 */
function extractBotsCopilotAutoReview(raw: unknown): boolean | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const bots = (raw as Record<string, unknown>).bots;
  if (typeof bots !== "object" || bots === null) return undefined;
  const v = (bots as Record<string, unknown>).copilotAutoReview;
  return typeof v === "boolean" ? v : undefined;
}

function stringArray(x: unknown): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out = x.filter((e): e is string => typeof e === "string");
  return out.length === x.length ? out : undefined;
}

/**
 * Merges a configured array OVER the built-in defaults as a union, so a
 * per-repo override ADDS to (does not replace) the defaults. Order:
 * defaults first, then configured extras not already present.
 */
function mergeGlobs(
  defaults: string[],
  configured: string[] | undefined,
): string[] {
  if (!configured || configured.length === 0) return [...defaults];
  const out = [...defaults];
  for (const g of configured) if (!out.includes(g)) out.push(g);
  return out;
}

/** Global claim-deadline override mirroring `bots.copilot`'s shape — a positive-integer sibling of `bots.copilot`. */
export function readCopilotClaimDeadlineSec(
  read: ReadConfigFile = defaultReadConfigFile,
): number | undefined {
  return extractBotsCopilotClaimDeadlineSec(read());
}

/** Global budget toggle: `bots.copilotSkipWait: true` makes the request path
 * decline (no Copilot request) and collapses the bot wait. A top-level boolean
 * sibling of `bots.copilotClaimDeadlineSec`; true only when strictly boolean
 * true — false/absent/malformed all read false. */
export function readCopilotSkipWait(
  read: ReadConfigFile = defaultReadConfigFile,
): boolean {
  return extractBotsCopilotSkipWait(read());
}

/** Tri-state override for "is Copilot review configured": `true`/`false` force the
 * resolver's verdict (short-circuiting the ruleset read and the 5-PR heuristic);
 * `undefined` (absent/missing-bots/wrong-typed) defers to auto-detect. */
export function readCopilotAutoReview(
  read: ReadConfigFile = defaultReadConfigFile,
): boolean | undefined {
  return extractBotsCopilotAutoReview(read());
}

/** Login-only accessor — the shape `flow-ci-wait`'s `readCopilotLogin` seam wants. */
export function readCopilotLogin(
  read: ReadConfigFile = defaultReadConfigFile,
): string {
  return readCopilotConfig(read).login;
}

/** Full reader: login + glob sets (configured arrays merged over the defaults). */
export function readCopilotConfig(
  read: ReadConfigFile = defaultReadConfigFile,
): CopilotConfig {
  const defaults: CopilotConfig = {
    login: DEFAULT_COPILOT_LOGIN,
    globs: {
      alwaysReview: [...DEFAULT_ALWAYS_REVIEW_GLOBS],
      neverAlone: [...DEFAULT_NEVER_ALONE_GLOBS],
    },
  };
  const copilot = extractBotsCopilot(read());
  if (copilot === undefined) return defaults;
  if (typeof copilot === "string") {
    return { login: copilot, globs: defaults.globs };
  }
  const login =
    typeof copilot.login === "string" ? copilot.login : DEFAULT_COPILOT_LOGIN;
  const globsObj =
    typeof copilot.globs === "object" && copilot.globs !== null
      ? (copilot.globs as Record<string, unknown>)
      : {};
  return {
    login,
    globs: {
      alwaysReview: mergeGlobs(
        DEFAULT_ALWAYS_REVIEW_GLOBS,
        stringArray(globsObj.alwaysReview),
      ),
      neverAlone: mergeGlobs(
        DEFAULT_NEVER_ALONE_GLOBS,
        stringArray(globsObj.neverAlone),
      ),
    },
  };
}
