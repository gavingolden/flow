/**
 * `flow attach [name]` — pure tmux passthrough. If `name` is omitted and
 * exactly one window exists, attach to it. Otherwise error.
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
    if (windows.length === 1) {
      // Prefer the slug (canonical identifier) so execAttach's
      // slug-keyed resolver finds it via @flow-slug. Fall back to the
      // display name for pre-upgrade windows that don't carry the
      // option yet.
      execAttach(windows[0].slug || windows[0].name);
    }
    if (windows.length === 0) {
      console.error(`flow attach: no windows in the '${FLOW_SESSION}' session.`);
      return 1;
    }
    console.error(`flow attach: multiple windows — pick one:`);
    for (const w of windows) console.error(`  ${w.slug || w.name}`);
    return 1;
  }

  if (!findWindowBySlug(windows, name)) {
    console.error(`flow attach: pipeline '${name}' not found in '${FLOW_SESSION}' session.`);
    return 1;
  }

  execAttach(name);
}
