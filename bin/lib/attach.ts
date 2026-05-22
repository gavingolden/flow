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

/**
 * CLI shim for `bin/flow`'s `attach` verb. Intercepts --help / -h before
 * any tmux query, then dispatches the first positional arg to `runAttach`.
 */
export function runAttachCli(args: string[]): number {
  if (argsContainHelp(args)) {
    printVerbHelp("attach");
    return 0;
  }
  return runAttach(args[0]);
}

export function runAttach(name?: string): number {
  if (!sessionExists()) {
    console.error(`flow attach: no '${FLOW_SESSION}' tmux session. Start one with 'flow new'.`);
    return 1;
  }

  const windows = listWindows();
  if (!name) {
    if (windows.length === 0) {
      console.error(`flow attach: no windows in the '${FLOW_SESSION}' session.`);
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
    console.error(`flow attach: pipeline '${name}' not found in '${FLOW_SESSION}' session.`);
    return 1;
  }

  execAttach(name);
}
