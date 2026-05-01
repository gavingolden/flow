/**
 * `flow attach [name]` — pure tmux passthrough. If `name` is omitted and
 * exactly one window exists, attach to it. Otherwise error.
 */

import { execAttach, listWindows, sessionExists, FLOW_SESSION } from "./tmux";

export function runAttach(name?: string): number {
  if (!sessionExists()) {
    console.error(`flow attach: no '${FLOW_SESSION}' tmux session. Start one with 'flow new'.`);
    return 1;
  }

  const windows = listWindows();
  if (!name) {
    if (windows.length === 1) {
      execAttach(windows[0].name);
    }
    if (windows.length === 0) {
      console.error(`flow attach: no windows in the '${FLOW_SESSION}' session.`);
      return 1;
    }
    console.error(`flow attach: multiple windows — pick one:`);
    for (const w of windows) console.error(`  ${w.name}`);
    return 1;
  }

  if (!windows.some((w) => w.name === name)) {
    console.error(`flow attach: window '${FLOW_SESSION}:${name}' not found.`);
    return 1;
  }

  execAttach(name);
}
