import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";

// Sandboxed $HOME for the entire test suite. A test that calls into code
// reading os.homedir() — most often setup-rc.ts editing shell rc files —
// would otherwise touch the test author's real ~/.zshrc / ~/.bashrc /
// ~/.bash_profile. Per-test homeDir overrides remain the precise fix; this
// is the global net.
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
