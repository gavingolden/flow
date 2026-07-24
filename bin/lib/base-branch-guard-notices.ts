import type { HooksTarget } from "./hooks-target";

/**
 * Notice-text builders for `base-branch-guard.ts`, split out purely to keep
 * that module under the AGENTS.md < 200 lines/file target — the three
 * inlined legacy hook bodies there already consume most of the budget.
 */

const SOURCE_SAFE_SNIPPET =
  '[ -r "$HOME/.flow/hooks/base-branch-guard.sh" ] && . "$HOME/.flow/hooks/base-branch-guard.sh"';

/**
 * Pure — returns the multi-line stderr text for the foreign-hook path so it
 * is assertable without capturing console output. STDOUT is off-limits for
 * this message: `bin/lib/epic-launch.ts`'s `parseMintedSlug` reads only
 * stdout's first line for the `flow:<slug>` contract token, so a stray
 * stdout line here would silently break epic slug minting.
 */
export function foreignHookNotice(
  target: HooksTarget,
  hookPath: string,
  sidecarPath: string,
): string {
  const managedBy = target.manager === "husky" ? " (managed by husky)" : "";
  const enableTarget =
    target.manager === "husky"
      ? `${target.mainWorktree}/.husky/pre-commit`
      : "your pre-commit hook";
  return [
    `flow feature create: base-branch guard not installed — ${hookPath} is not flow's${managedBy}`,
    `  guard available at ${sidecarPath} (nothing was written to your repo)`,
    `  enable it by adding this line to ${enableTarget}:`,
    `    ${SOURCE_SAFE_SNIPPET}`,
  ].join("\n");
}

/** Loud (never dimmed) — may name a now-dirty tracked file. */
export function upgradeNotice(
  hookPath: string,
  fromDescription: string,
  tracked: boolean,
  version: number,
): string {
  const lines = [
    `flow feature create: upgraded the base-branch guard at ${hookPath} (${fromDescription} -> v${version}).`,
  ];
  if (tracked) {
    lines.push(
      `  ${hookPath} is a TRACKED file and is now dirty — review and commit the change.`,
    );
  }
  return lines.join("\n");
}

/** Never downgrades a newer flow-owned hook. */
export function newerHookNotice(
  hookPath: string,
  newerVersion: number | null,
): string {
  return `flow feature create: a newer base-branch guard (v${newerVersion ?? "?"}) is already at ${hookPath} — not downgrading.`;
}
