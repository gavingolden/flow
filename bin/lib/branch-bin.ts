/**
 * Per-run shim dir for step 8c: a bare `flow` / `flow-*` command in a Test
 * Step runs the branch's files (never the installed copy) with the real HOME,
 * so a flow PR's own new helpers and verbs are exercisable before merge.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isFlowSource } from "./install-only-names";
import { isPathBoundHelper } from "./sources";

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const INSTALL_REFUSAL =
  "flow install is not run from the branch in Test Steps — it would repoint the global install for every running pipeline";

function helperShim(abs: string): string {
  return `#!/bin/sh\nexec bun ${q(abs)} "$@"\n`;
}

function flowShim(abs: string): string {
  return (
    `#!/bin/sh\nif [ "$1" = install ]; then echo ${q(INSTALL_REFUSAL)} >&2; exit 2; fi\n` +
    `exec bun ${q(abs)} "$@"\n`
  );
}

/** `<worktree>/.flow-tmp/branch-bin` in a flow checkout, else null. */
export function ensureBranchBin(worktree: string): string | null {
  if (!isFlowSource(worktree)) return null;
  const abs = path.resolve(worktree);
  const dir = path.join(abs, ".flow-tmp", "branch-bin");
  fs.mkdirSync(dir, { recursive: true });

  const shims = new Map<string, string>();
  for (const file of fs.readdirSync(path.join(abs, "bin"))) {
    if (!isPathBoundHelper(file)) continue;
    shims.set(
      file.replace(/\.ts$/, ""),
      helperShim(path.join(abs, "bin", file)),
    );
  }
  shims.set("flow", flowShim(path.join(abs, "bin", "flow")));

  for (const stale of fs.readdirSync(dir)) {
    if (!shims.has(stale)) fs.rmSync(path.join(dir, stale), { force: true });
  }
  for (const [name, text] of shims) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  return dir;
}
