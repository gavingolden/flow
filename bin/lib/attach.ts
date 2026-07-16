/**
 * `flow attach [name]` — pure tmux passthrough. Bare `flow attach` attaches
 * into the `flow` session for browsing (focusing the most-recently-active
 * window when several exist), and errors only when the session or its
 * windows don't exist.
 */

import { argsContainHelp, printVerbHelp } from "./help";
import {
  execAttach,
  findWindowBySlug,
  listWindows,
  sessionExists,
  FLOW_SESSION,
} from "./tmux";
import { readState } from "./state";
import { plainAttachHint } from "./launcher";

/**
 * CLI shim for `bin/flow`'s `attach` verb. Intercepts --help / -h before
 * any tmux query, then dispatches the first positional arg to `runAttach`.
 */
export function runAttachCli(args: string[]): number {
  if (argsContainHelp(args)) {
    printVerbHelp("attach");
    return 0;
  }
  // A tmux client attaches to exactly one window; a slug list has no coherent
  // attach semantics. Reject >1 positional slug with a clear error instead of
  // today's silent drop of args[1..].
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length > 1) {
    console.error(
      `flow attach: attaches to a single window; got ${positional.length} — attach them one at a time.`,
    );
    return 1;
  }
  return runAttach(positional[0]);
}

export function runAttach(name?: string): number {
  // A named pipeline with recorded state but NO tmux window is (most likely)
  // plain-launched: attach is a tmux-launcher feature, so print the named
  // hint (pid included) instead of the generic not-found error.
  const plainHint = (slug: string): number | null => {
    const state = readState(slug);
    if (state == null) return null;
    console.error(plainAttachHint(state));
    return 1;
  };

  if (!sessionExists()) {
    if (name) {
      const hinted = plainHint(name);
      if (hinted != null) return hinted;
    }
    console.error(
      `flow attach: no '${FLOW_SESSION}' tmux session. Start one with 'flow feature create'.`,
    );
    return 1;
  }

  const windows = listWindows();
  if (!name) {
    if (windows.length === 0) {
      console.error(
        `flow attach: no windows in the '${FLOW_SESSION}' session.`,
      );
      return 1;
    }
    // Bare attach lands the user in the session for browsing; with several
    // windows the most-recently-active is focused so they switch with
    // native tmux keys (prefix + w / n / p). Prefer the slug (canonical
    // @flow-slug identifier) and fall back to the display name for
    // pre-upgrade windows that don't carry the option yet.
    const target = windows.reduce((a, b) => (b.activity > a.activity ? b : a));
    return execAttach(target.slug || target.name);
  }

  if (!findWindowBySlug(windows, name)) {
    const hinted = plainHint(name);
    if (hinted != null) return hinted;
    console.error(
      `flow attach: pipeline '${name}' not found in '${FLOW_SESSION}' session.`,
    );
    return 1;
  }

  return execAttach(name);
}
