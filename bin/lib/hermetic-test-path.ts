import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Test-support guard. The real home comes from os.userInfo(), never $HOME or
// os.homedir(): those are exactly what goes wrong when a test replaces
// process.env, so they cannot be the reference for "the real home".
export const ORIGINAL_ENV_KEY = "__flowOriginalProcessEnv";

export function realAccountHome(): string {
  return os.userInfo().homedir;
}

function resolveNearest(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

let tmpRoot: string | undefined;
let homeRoot: string | undefined;
const tmpReal = () => (tmpRoot ??= resolveNearest(os.tmpdir()));
const homeReal = () => (homeRoot ??= resolveNearest(realAccountHome()));

export function assertHermeticTestPath(target: string): void {
  let isLink = false;
  try {
    isLink = fs.lstatSync(target).isSymbolicLink();
  } catch {
    // not created yet
  }
  if (isLink) throw new Error(`refusing test write to ${target}: symlink`);
  const resolved = resolveNearest(target);
  if (!isUnder(resolved, tmpReal())) {
    const why = isUnder(resolved, homeReal())
      ? "inside-real-home"
      : "outside-tmpdir";
    throw new Error(`refusing test write to ${target}: ${why}`);
  }
}

export function homeSandboxViolation(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const home = os.homedir();
  if (env.HOME !== home)
    return `process.env.HOME (${env.HOME}) differs from os.homedir() (${home})`;
  const recorded = (globalThis as Record<string, unknown>)[ORIGINAL_ENV_KEY];
  if (recorded !== undefined && env !== recorded)
    return "process.env was replaced with a different object (os.homedir() can desync)";
  const resolved = resolveNearest(home);
  if (!isUnder(resolved, tmpReal()) && isUnder(resolved, homeReal()))
    return `os.homedir() (${home}) resolves inside the real account home`;
  return null;
}
