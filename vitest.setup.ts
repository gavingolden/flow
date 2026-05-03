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
// homedir lazily and is fully covered. A test that consumes a paths.ts
// default like `dir = FLOW_STATE_DIR` without a DI override would still
// touch the real ~/.flow/. No current test reaches that path; tightening
// paths.ts to lazy evaluation is tracked as a followup in PR #86.
let originalHome: string | undefined;
let sandboxHome: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vitest-home-"));
  process.env.HOME = sandboxHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (sandboxHome) fs.rmSync(sandboxHome, { recursive: true, force: true });
});
