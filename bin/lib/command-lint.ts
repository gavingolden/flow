/**
 * Shared primitives for the two recipe-command lints
 * (`bin/gate-summary-recipe-lint.test.ts` and `bin/failure-docs-lint.test.ts`).
 * Reusable rules live here so both lints enforce identical checks rather than
 * drifting into two designs.
 *
 * Plain module — NOT a shipped helper. `discoverHelpers` (bin/lib/sources.ts)
 * only scans top-level `bin/*.ts`, and `discoverValidators` uses an explicit
 * `VALIDATOR_MODULES` allowlist, so this file is never symlinked onto a
 * user's PATH. No Bun shebang, no `chmod +x`, no `import.meta.main` gate.
 */

import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { VERBS } from "./verbs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(HERE, "..");

/**
 * Every `<slug>`-style placeholder the recipe corpus actually uses, plus the
 * `<merged|gated|...>` compound form — a recipe introducing a new one must
 * extend this allowlist explicitly.
 */
export const PLACEHOLDER_ALLOWLIST: readonly string[] = [
  "<slug>",
  "<pr>",
  "<PR>",
  "<base>",
  "<worktree>",
  "<repo>",
  "<pr-branch>",
  "<resolved-files>",
  "<step>",
  "<description>",
  "<victim-slug>",
  "<merged|gated|...>",
];

/** `bin/*.ts` basenames (extension stripped) — helper names lead real commands. */
export function helperNames(): string[] {
  return readdirSync(BIN_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""));
}

// The shared command-word vocabulary: a small closed base set UNION every
// bin/*.ts helper basename. A closed base set alone can't accept the real
// corpus (led by flow-state-update, flow-merge-guard, ...); unioning in
// helperNames() means a new binary that trips the Rule-3 detector also
// extends the vocabulary a declared command's first token is checked
// against — one list feeds both the detector and the acceptor.
export const COMMAND_WORDS: readonly string[] = [
  "git",
  "gh",
  "flow",
  "cd",
  "npm",
  "bun",
  "test",
  ...helperNames(),
];

export function flowVerbs(): string[] {
  return [...VERBS];
}

/**
 * Single permissive substitution pass. A restrictive `/<[^>|]+>/g` first pass
 * (tried and rejected) SKIPS `<merged|gated|...>`, leaving a bare `|` that
 * makes `bash -n` read a pipe-to-redirect and go red — so every `<...>` span
 * is replaced in one pass, regardless of internal characters.
 */
export function substitutePlaceholders(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "PLACEHOLDER");
}

export function bashParses(fragment: string): boolean {
  const result = spawnSync("bash", ["-n"], { input: fragment });
  return result.status === 0;
}

/**
 * First token must be a known command word; when it is exactly `flow`, the
 * second token must be a real dispatcher verb (per `flowVerbs()`) — catches
 * the `flow new` regression this lint exists to prevent.
 */
export function firstTokenOk(fragment: string): boolean {
  const tokens = fragment.trim().split(/\s+/);
  const first = tokens[0];
  if (!first || !COMMAND_WORDS.includes(first)) return false;
  if (first === "flow") {
    const second = tokens[1];
    return second !== undefined && flowVerbs().includes(second);
  }
  return true;
}

export function hasShellcheck(): boolean {
  return (
    spawnSync("shellcheck", ["--version"], { encoding: "utf8" }).status === 0
  );
}

export function shellcheckOk(fragment: string): boolean {
  const result = spawnSync(
    "shellcheck",
    ["--severity=error", "--shell=bash", "-"],
    { input: fragment, encoding: "utf8" },
  );
  return result.status === 0;
}
