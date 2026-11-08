/**
 * The manager's scope-free home, `~/.flow/manager/`: grants, decision log,
 * scope, notes, proposals and status. It sits beside (not under) the state
 * dir, so `listStates` never sees it.
 *
 * Resolved at call time on purpose: a module-level constant would freeze the
 * real `$HOME` at import and escape the test sandbox's HOME.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function managerHome(): string {
  return path.join(os.homedir(), ".flow", "manager");
}

export function managerFile(
  name: string,
  home: string = managerHome(),
): string {
  return path.join(home, name);
}

export function managerLockPath(
  name: string,
  home: string = managerHome(),
): string {
  return path.join(home, `${name}.lock`);
}

/** Write-to-temp then rename, so a reader never sees a half-written file. */
export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
