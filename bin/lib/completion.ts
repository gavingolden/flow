/**
 * `flow completion <shell>` — escape-hatch subcommand that prints a shell
 * completion script to stdout. Primary install path is `flow setup`'s rc-file
 * editing; this verb is for users on read-only homedirs (NixOS / Guix), CI
 * environments, or anyone who prefers explicit `eval "$(flow completion zsh)"`
 * sourcing in their rc.
 *
 * Source files live under <flow-source>/completions/ and are also symlinked
 * into ~/.flow/completions/ by `flow setup`. This verb reads them from the
 * canonical source so the output is byte-identical to what's auto-installed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFlowSource } from "./paths";

export const SUPPORTED_SHELLS = ["bash", "zsh"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export type CompletionOptions = {
  flowSource?: string;
  /** Output sink, defaults to writing to process.stdout. Test-only override. */
  out?: (s: string) => void;
};

export function runCompletion(shell: string | undefined, opts: CompletionOptions = {}): number {
  if (!shell) {
    console.error("flow completion: shell argument is required");
    console.error(`usage: flow completion <${SUPPORTED_SHELLS.join("|")}>`);
    return 2;
  }

  if (!isSupported(shell)) {
    console.error(
      `flow completion: unsupported shell '${shell}' (supported: ${SUPPORTED_SHELLS.join(", ")})`,
    );
    return 2;
  }

  const source = opts.flowSource ?? resolveFlowSource();
  const scriptPath = path.join(source, "completions", `flow.${shell}`);

  let contents: string;
  try {
    contents = fs.readFileSync(scriptPath, "utf8");
  } catch (err) {
    console.error(`flow completion: cannot read ${scriptPath}: ${(err as Error).message}`);
    return 1;
  }

  const out = opts.out ?? ((s) => process.stdout.write(s));
  out(contents);
  return 0;
}

function isSupported(shell: string): shell is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}
