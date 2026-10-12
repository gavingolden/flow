import { STACK_TABLE } from "./stack-table";

export type DedupeItem = { scope: string; argv: readonly string[] };
export type DedupableResult = {
  name: string;
  scope: string;
  durationMs: number;
  dedupedFrom?: string;
};

const NPM_VERIFY_SCRIPTS = new Set<string>([
  ...(STACK_TABLE["package.json"].verifyScriptOrder ?? []).flat(),
  "test:related",
]);

export function checkKey(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

/** Exact-argv reuse is only safe for commands that verify and never mutate
 * the tree. Reuse is decided purely by command shape (this list), not by where
 * the command came from: a configured command spelled like a known verifier
 * (e.g. `npm run test`) is reused too. Any command not on the list (build,
 * generate, other user commands) always runs and resets reuse. */
export function isReadOnlyVerifier(argv: readonly string[]): boolean {
  const [bin, sub, script] = argv;
  if (bin === "flow-md-validate" || bin === "actionlint") return true;
  if (bin === "npm") {
    if (sub !== "run" || script === undefined) return false;
    return NPM_VERIFY_SCRIPTS.has(script) || script.startsWith("typecheck:");
  }
  if (bin === "go") {
    let i = 1;
    while (argv[i] === "-C") i += 2;
    return argv[i] === "vet" || argv[i] === "test";
  }
  return false;
}

export function runDeduped<I extends DedupeItem, R extends DedupableResult>(
  items: readonly I[],
  execute: (item: I) => R,
): { results: R[]; savedMs: number } {
  const seen = new Map<string, R>();
  const results: R[] = [];
  let savedMs = 0;
  for (const item of items) {
    if (!isReadOnlyVerifier(item.argv)) {
      // A mutating command may change what a later verifier sees, so any
      // earlier result is no longer safe to reuse.
      seen.clear();
      results.push(execute(item));
      continue;
    }
    const key = checkKey(item.argv);
    const first = seen.get(key);
    if (first) {
      savedMs += first.durationMs;
      results.push({
        ...first,
        scope: item.scope,
        durationMs: 0,
        dedupedFrom: first.scope,
      });
      continue;
    }
    const result = execute(item);
    seen.set(key, result);
    results.push(result);
  }
  return { results, savedMs };
}
