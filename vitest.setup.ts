import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";

// Sandboxed $HOME for the entire test suite. A test that calls into code
// reading os.homedir() — most often setup-rc.ts editing shell rc files —
// would otherwise touch the test author's real ~/.zshrc / ~/.bashrc /
// ~/.bash_profile. Per-test homeDir overrides remain the precise fix; this
// is the global net.
//
// Coverage: this only protects code that reads os.homedir() / process.env.HOME
// *lazily* (at function-call time). Modules that capture HOME at import time —
// notably bin/lib/paths.ts (`HOME = os.homedir()` at module scope, with the
// derived FLOW_DIR / FLOW_STATE_DIR / etc constants frozen) — are imported
// before vitest evaluates this file, so their captured value is the real
// $HOME. setup-rc.ts (the rc-editing path that motivated this file) reads
// homedir lazily and is fully covered. The `~/.flow/config.json` readers
// (models-config, copilot-config, epic-config, update-check) are covered too:
// they resolve the path via paths.ts's `flowConfigPath()` at call time rather
// than an import-time constant. A test that consumes another
// paths.ts default like `dir = FLOW_STATE_DIR` without a DI override would
// still touch the real ~/.flow/; tightening the remaining constants to lazy
// evaluation is tracked as a followup in PR #86.
let originalHome: string | undefined;
let sandboxHome: string | undefined;
let originalFlowSlug: string | undefined;
let originalTmuxPane: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vitest-home-"));
  process.env.HOME = sandboxHome;

  // After f4 (env/state-only session identity), FLOW_SLUG is the sole
  // identity carrier — no tmux pane fallback remains. An ambient FLOW_SLUG /
  // TMUX_PANE from a live flow window would otherwise leak into every
  // ambient-resolution test in the suite, so strip both for the suite's
  // duration and restore them afterward.
  originalFlowSlug = process.env.FLOW_SLUG;
  originalTmuxPane = process.env.TMUX_PANE;
  delete process.env.FLOW_SLUG;
  delete process.env.TMUX_PANE;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (sandboxHome) fs.rmSync(sandboxHome, { recursive: true, force: true });

  if (originalFlowSlug === undefined) delete process.env.FLOW_SLUG;
  else process.env.FLOW_SLUG = originalFlowSlug;
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
});
