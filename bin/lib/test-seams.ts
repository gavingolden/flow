// Fail-closed dependency builder for helpers that take a complete `Deps`
// object. Test-only: production code never imports this module, and it
// imports nothing from vitest (like hermetic-test-path.ts).
//
// `strictDeps(realDeps(), overrides)` keeps every override and replaces each
// other function seam with a stub that records the hit and throws
// UnstubbedSeamError, so a forgotten seam can never fall through to real fs,
// network or spawn. Helpers swallow seam errors in several catch blocks, so
// the recorded hits are also checked suite-wide by assertNoUnstubbedSeamHits.
// That swallowed-hit net only runs under vitest.config.ts's setup file
// (`npm test` / `npm run verify`); a bare vitest launch skips it.
//
// Hits live on globalThis, not in a module variable: the setup file's
// vi.resetModules() gives each test file its own copy of this module.

const HITS_KEY = "__flowUnstubbedSeamHits";

function hits(): string[] {
  const g = globalThis as Record<string, unknown>;
  return (g[HITS_KEY] ??= []) as string[];
}

export class UnstubbedSeamError extends Error {
  readonly seam: string;
  constructor(seam: string) {
    super(
      `seam "${seam}" was called but not stubbed; override it or opt in with pickSeams(realDeps(), ["${seam}"])`,
    );
    this.name = "UnstubbedSeamError";
    this.seam = seam;
  }
}

function describeArg(arg: unknown): string {
  if (arg === undefined) return "";
  return typeof arg === "string" ? JSON.stringify(arg) : typeof arg;
}

export function strictDeps<D extends object>(
  real: D,
  overrides: Partial<D>,
): D {
  const out: Record<string, unknown> = {};
  const over = overrides as Record<string, unknown>;
  for (const key of Object.keys(real)) {
    if (over[key] !== undefined) {
      out[key] = over[key];
    } else if (typeof (real as Record<string, unknown>)[key] === "function") {
      out[key] = (...args: unknown[]) => {
        hits().push(`${key}(${describeArg(args[0])})`);
        throw new UnstubbedSeamError(key);
      };
    } else {
      throw new UnstubbedSeamError(key);
    }
  }
  return out as D;
}

export function pickSeams<D extends object, K extends keyof D>(
  real: D,
  seams: readonly K[],
): Pick<D, K> {
  const out = {} as Pick<D, K>;
  for (const k of seams) out[k] = real[k];
  return out;
}

export function takeUnstubbedSeamHits(): string[] {
  const g = globalThis as Record<string, unknown>;
  const taken = hits().slice();
  g[HITS_KEY] = [];
  return taken;
}

export function assertNoUnstubbedSeamHits(): void {
  const taken = takeUnstubbedSeamHits();
  if (taken.length === 0) return;
  throw new Error(
    `unstubbed seams were called (possibly swallowed by the code under test): ${taken.join(", ")}`,
  );
}

export async function expectUnstubbedSeam(
  fn: () => unknown,
  seam: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  const g = globalThis as Record<string, unknown>;
  const prefix = `${seam}(`;
  const own = hits().filter((h) => h.startsWith(prefix));
  g[HITS_KEY] = hits().filter((h) => !h.startsWith(prefix));
  const threw = thrown instanceof UnstubbedSeamError && thrown.seam === seam;
  if (!threw && own.length === 0) {
    throw new Error(
      `expected an unstubbed "${seam}" seam hit, got ${thrown === undefined ? "no error and no recorded hit" : String(thrown)}`,
    );
  }
}
