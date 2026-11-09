import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import {
  ORIGINAL_ENV_KEY,
  homeSandboxViolation,
  realAccountHome,
} from "./bin/lib/hermetic-test-path";

// Sandboxed $HOME for the entire test suite. A test that calls into code
// reading os.homedir() — most often setup-rc.ts editing shell rc files —
// would otherwise touch the test author's real ~/.zshrc / ~/.bashrc /
// ~/.bash_profile. Per-test homeDir overrides remain the precise fix; this
// is the global net.
//
// Coverage: HOME is swapped at module load, before the test file's imports
// and collection, and stays on the sandbox until the worker exits (it is
// never restored to the real home). bin/lib/paths.ts resolves flowDir() /
// flowStateDir() and friends at call time from HOME, so they follow the
// sandbox, and so does module-scope test code. The sandbox is emptied (not
// removed) after each file so paths captured by module-scope test code stay
// valid under --no-isolate. A global beforeEach/afterEach tripwire fails the first test
// that replaces process.env or desyncs os.homedir() from HOME. A vitest
// launch that skips vitest.config.ts gets no sandbox at all.
//
// Shared-worker (--no-isolate) runs, flow#1041: a test file's vi.mock is
// bypassed when an earlier file in the same worker already loaded the real
// module, and mocks / evaluated modules leak forward. The top-level
// vi.resetModules() below gives every file a fresh module registry. Separately,
// a forks-pool worker's stdin is a pipe vitest never closes, so a synchronous
// fs.readSync(0) blocks the worker's only thread forever and no per-test
// timeout can fire; the stdin guard turns that read into end-of-input.
const STDIN_GUARD_KEY = "__flowStdinGuardInstalled";
const g = globalThis as Record<string, unknown>;
if (!g[STDIN_GUARD_KEY]) {
  g[STDIN_GUARD_KEY] = true;
  // Forked child only: under pool:threads fd 0 is the main process's stdin.
  if (typeof process.send === "function") {
    try {
      if (!fs.fstatSync(0).isCharacterDevice()) {
        try {
          fs.closeSync(0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EBADF") throw err;
        }
        const fd = fs.openSync("/dev/null", "r");
        if (fd !== 0) fs.closeSync(fd);
      }
    } catch {
      // Never throw from setup: it would fail every file in the worker.
    }
  }
}

// State shared between this setup file and test files must live on globalThis
// or process.env (like ORIGINAL_ENV_KEY), never in a module-scoped variable of
// a helper imported here: the per-file reset splits such a helper in two.
vi.resetModules();

const realHome = realAccountHome();
// Seam for credential-needing *.live.test.ts only; deliberately not a general
// escape hatch for tests that want the real home.
process.env.FLOW_TEST_REAL_HOME ??= realHome;

const SANDBOX_PREFIX = "flow-vitest-home-";
// Reuse is limited to the process that created the sandbox (vitest re-imports
// this file per test file). A child process — a nested vitest a test spawns —
// inherits HOME and must get its own sandbox, or its afterAll would empty the
// parent worker's home mid-test.
const OWNER_PID_KEY = "FLOW_VITEST_HOME_OWNER_PID";
let sandboxHome: string;
{
  const existing = process.env.HOME;
  if (
    existing &&
    process.env[OWNER_PID_KEY] === String(process.pid) &&
    path.basename(existing).startsWith(SANDBOX_PREFIX) &&
    path.dirname(existing) === os.tmpdir() &&
    fs.existsSync(existing)
  ) {
    sandboxHome = existing;
  } else {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
    process.env.HOME = sandboxHome;
    process.env[OWNER_PID_KEY] = String(process.pid);
    process.on("exit", () => {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    });
  }
}

g[ORIGINAL_ENV_KEY] ??= process.env;

const OFFENDER_KEY = "__flowFirstHomeSandboxOffender";

function assertSandbox(): void {
  const violation = homeSandboxViolation();
  if (violation === null) return;
  const { testPath, currentTestName } = expect.getState();
  g[OFFENDER_KEY] ??= `${testPath ?? "?"} > ${currentTestName ?? "?"}`;
  throw new Error(
    `HOME sandbox violated: ${violation}. First offending test in this worker: ${String(g[OFFENDER_KEY])}`,
  );
}

let originalFlowSlug: string | undefined;
let originalTmuxPane: string | undefined;
let originalClaudeEffort: string | undefined;
let originalKeepAwake: string | undefined;

beforeAll(() => {
  if (process.env.HOME !== sandboxHome) process.env.HOME = sandboxHome;

  // After f4 (env/state-only session identity), FLOW_SLUG is the sole
  // identity carrier — no tmux pane fallback remains. An ambient FLOW_SLUG /
  // TMUX_PANE from a live flow window would otherwise leak into every
  // ambient-resolution test in the suite, so strip both for the suite's
  // duration and restore them afterward.
  originalFlowSlug = process.env.FLOW_SLUG;
  originalTmuxPane = process.env.TMUX_PANE;
  delete process.env.FLOW_SLUG;
  delete process.env.TMUX_PANE;

  // Claude Code exports CLAUDE_EFFORT to every Bash call, and telemetry's
  // `session_effort` reads it: a suite run from a Claude Code Bash call would
  // otherwise inherit the ambient level (the same leak shape as FLOW_SLUG).
  originalClaudeEffort = process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_EFFORT;

  // Makes the keep-awake holder inert for the whole suite: phase writes call
  // syncKeepAwake, which would otherwise spawn a real `caffeinate` and write
  // to the real ~/.flow procs registry.
  originalKeepAwake = process.env.FLOW_KEEP_AWAKE;
  process.env.FLOW_KEEP_AWAKE = "0";
});

beforeEach(assertSandbox);
afterEach(assertSandbox);

afterAll(() => {
  // Seam for credential-needing live tests (`bin/*.live.test.ts`) is
  // FLOW_TEST_REAL_HOME, set above and never deleted.
  for (const entry of fs.readdirSync(sandboxHome)) {
    fs.rmSync(path.join(sandboxHome, entry), { recursive: true, force: true });
  }
  process.env.HOME = sandboxHome;

  if (originalFlowSlug === undefined) delete process.env.FLOW_SLUG;
  else process.env.FLOW_SLUG = originalFlowSlug;
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
  if (originalClaudeEffort === undefined) delete process.env.CLAUDE_EFFORT;
  else process.env.CLAUDE_EFFORT = originalClaudeEffort;
  if (originalKeepAwake === undefined) delete process.env.FLOW_KEEP_AWAKE;
  else process.env.FLOW_KEEP_AWAKE = originalKeepAwake;
});
