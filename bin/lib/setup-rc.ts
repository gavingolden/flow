/**
 * The rc-file editing step of `flow setup`. Adds (or, with --no-completions,
 * removes) a `# managed by flow completions` block in each shell rc file the
 * user already has. Never creates an rc file we didn't author. Marker
 * convention matches `bin/lib/rc-block.ts` and the older gitignore module.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyManagedBlock, hasManagedBlock } from "./rc-block";
import type { InstallTargets } from "./sources";

const RC_BLOCK_TAG = "completions";

const RC_FILES_BY_SHELL: ReadonlyArray<{ filename: string; shell: "bash" | "zsh" }> = [
  { filename: ".zshrc", shell: "zsh" },
  { filename: ".bashrc", shell: "bash" },
  { filename: ".bash_profile", shell: "bash" },
];

export type ApplyRcOptions = {
  /**
   * If true, remove an existing managed block instead of upserting one. A
   * fresh run with this flag set is a no-op (no block existed to remove).
   */
  remove?: boolean;
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
};

export function applyShellRcCompletions(
  targets: InstallTargets,
  options: ApplyRcOptions,
  log: (msg: string) => void,
): void {
  const home = options.homeDir ?? os.homedir();
  const remove = options.remove === true;

  for (const { filename, shell } of RC_FILES_BY_SHELL) {
    const rcPath = path.join(home, filename);
    if (!fs.existsSync(rcPath)) continue;

    const before = fs.readFileSync(rcPath, "utf8");
    const blockExisted = hasManagedBlock(before, RC_BLOCK_TAG);
    const body = remove ? [] : [bodyLineFor(targets, shell)];
    const after = applyManagedBlock(before, RC_BLOCK_TAG, body);

    if (after === before) continue;

    fs.writeFileSync(rcPath, after);
    if (remove) {
      log(`  - rc ${rcPath}  (block removed)`);
    } else if (blockExisted) {
      log(`  ~ rc ${rcPath}  (block updated)`);
    } else {
      log(`  + rc ${rcPath}  (block added)`);
    }
  }
}

function bodyLineFor(targets: InstallTargets, shell: "bash" | "zsh"): string {
  // Sources from the install target (~/.flow/completions/flow.<shell>) rather
  // than the source-tree path so re-installing flow from a different checkout
  // doesn't break the user's rc. The `[ -f ... ]` guard silently no-ops when
  // the script is missing rather than printing a "command not found" error
  // on every shell startup.
  const scriptPath = `${targets.completionsDir}/flow.${shell}`;
  return `[ -f "${scriptPath}" ] && source "${scriptPath}"`;
}
