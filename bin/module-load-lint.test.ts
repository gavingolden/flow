import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Two structural guards against a failure vitest cannot reproduce: Bun
 * evaluates ES modules natively, so a runtime import loop leaves a
 * top-level `const` in its temporal dead zone and the script throws
 * `ReferenceError` on load, while vitest's module runner papers over it.
 *
 * 1. Static: no runtime import loop among the scripts under `bin/`,
 *    `scripts/` and `skills/` (plus the extensionless `bin/flow`).
 * 2. Dynamic: every entry point loads in a fresh `bun` process.
 */

const here =
  import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(here, "..");
const SCAN_DIRS = ["bin", "scripts", "skills"];
const UNRESOLVED = "unresolved:";

const HINT =
  "move the shared code into a module neither side imports, or mark a type-only import `import type`";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isScannable(rel: string): boolean {
  if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) return false;
  if (rel.startsWith("bin/fixtures/")) return false;
  return !rel.split("/").includes("node_modules");
}

function collectFiles(): string[] {
  const out: string[] = ["bin/flow"];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { recursive: true })) {
      const rel = toPosix(path.join(dir, String(entry)));
      if (isScannable(rel) && fs.statSync(path.join(ROOT, rel)).isFile()) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

function resolveSpecifier(
  from: string,
  spec: string,
  known: Set<string>,
): string | null {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), spec),
  );
  const stem = base.replace(/\.(js|ts)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}/index.ts`]) {
    if (known.has(c)) return c;
  }
  return null;
}

/** Erased by the TS compiler: `import type`, or only inline-`type` named members. */
function isTypeOnlyClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const nb = clause.namedBindings;
  if (nb === undefined || ts.isNamespaceImport(nb)) return false;
  return nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const ec = node.exportClause;
  if (ec === undefined || ts.isNamespaceExport(ec)) return false;
  return ec.elements.length > 0 && ec.elements.every((e) => e.isTypeOnly);
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function stringArg(call: ts.CallExpression): string | null {
  const a = call.arguments[0];
  return a !== undefined && ts.isStringLiteralLike(a) ? a.text : null;
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

function runtimeImportEdges(
  file: string,
  source: string,
  known: Set<string>,
): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyClause(node.importClause))
        specs.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(node)) specs.push(node.moduleSpecifier.text);
      return;
    }
    if (isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const spec = isDynamicImport || isRequire ? stringArg(node) : null;
      if (spec !== null) specs.push(spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const edges: string[] = [];
  for (const spec of specs) {
    if (!isRelative(spec)) continue;
    const resolved = resolveSpecifier(file, spec, known);
    edges.push(resolved ?? `${UNRESOLVED}${spec}`);
  }
  return edges;
}

/** Tarjan SCC; returns every component of size > 1 plus self-importing singletons. */
function findImportCycles(graph: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) {
        cycles.push(comp.sort());
      }
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) strong(v);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

function buildGraph(sources: Map<string, string>): {
  graph: Map<string, string[]>;
  unresolved: string[];
} {
  const known = new Set(sources.keys());
  const graph = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const [file, source] of sources) {
    const edges: string[] = [];
    for (const e of runtimeImportEdges(file, source, known)) {
      if (e.startsWith(UNRESOLVED)) {
        unresolved.push(`${file} -> ${e.slice(UNRESOLVED.length)}`);
      } else edges.push(e);
    }
    graph.set(file, edges);
  }
  return { graph, unresolved };
}

function cyclesOf(files: Record<string, string>): string[][] {
  const { graph } = buildGraph(new Map(Object.entries(files)));
  return findImportCycles(graph);
}

describe("import-loop detector (in-memory)", () => {
  it("should report a two-file runtime loop", () => {
    expect(
      cyclesOf({
        "a.ts": 'import { b } from "./b";',
        "b.ts": 'import { a } from "./a";',
      }),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  it("should not report a loop closed only by `import type`", () => {
    expect(
      cyclesOf({
        "a.ts": 'import type { B } from "./b";',
        "b.ts": 'import { a } from "./a";',
      }),
    ).toEqual([]);
  });

  it("should not report a loop closed only by an all-inline-type specifier list", () => {
    expect(
      cyclesOf({
        "a.ts": 'import { type B, type C } from "./b";',
        "b.ts": 'import { a } from "./a";',
      }),
    ).toEqual([]);
  });

  it("should count `export ... from` as an edge", () => {
    expect(
      cyclesOf({
        "a.ts": 'export { b } from "./b";',
        "b.ts": 'import { a } from "./a";',
      }),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  it("should not count `export type ... from` as an edge", () => {
    expect(
      cyclesOf({
        "a.ts": 'export type { B } from "./b";',
        "b.ts": 'import { a } from "./a";',
      }),
    ).toEqual([]);
  });

  it("should count `import D, { type E }` as an edge", () => {
    expect(
      cyclesOf({
        "a.ts": 'import D, { type E } from "./b";',
        "b.ts": 'import { a } from "./a";',
      }),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  it("should count `import {}` and side-effect imports as edges", () => {
    expect(
      cyclesOf({
        "a.ts": 'import {} from "./b";',
        "b.ts": 'import "./a";',
      }),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  it("should resolve a `.js` suffix and an index module", () => {
    expect(
      cyclesOf({
        "a.ts": 'import { b } from "./b.js";',
        "b.ts": 'import { c } from "./c";',
        "c/index.ts": 'import { a } from "../a";',
      }),
    ).toEqual([["a.ts", "b.ts", "c/index.ts"]]);
  });

  it("should report a self-import", () => {
    expect(cyclesOf({ "a.ts": 'import { a } from "./a";' })).toEqual([
      ["a.ts"],
    ]);
  });

  it("should count a module-top-level `await import()` and `require()`", () => {
    expect(
      cyclesOf({
        "a.ts": 'const b = await import("./b");',
        "b.ts": 'const a = require("./a");',
      }),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  it("should ignore a function-enclosed `import()`", () => {
    expect(
      cyclesOf({
        "a.ts": 'export async function f() { return import("./b"); }',
        "b.ts": 'import { f } from "./a";',
      }),
    ).toEqual([]);
  });

  it("should flag a relative specifier that resolves to nothing", () => {
    const { unresolved } = buildGraph(
      new Map([["a.ts", 'import { x } from "./missing";']]),
    );
    expect(unresolved).toEqual(["a.ts -> ./missing"]);
  });

  it("should ignore bare package specifiers", () => {
    const { unresolved } = buildGraph(
      new Map([["a.ts", 'import * as fs from "node:fs";']]),
    );
    expect(unresolved).toEqual([]);
  });
});

describe("module-load lint: static import graph", () => {
  const files = collectFiles();
  const sources = new Map(
    files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]),
  );
  const { graph, unresolved } = buildGraph(sources);

  it("should scan the modules behind the ui-critique crash", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "bin/flow-gate-decide.ts",
        "bin/lib/ui-review-gate.ts",
        "bin/lib/test-steps-section.ts",
      ]),
    );
    expect(loadTargets()).toContain("bin/flow-ui-critique.ts");
  });

  it("should resolve every relative import inside the scanned set", () => {
    expect(unresolved).toEqual([]);
  });

  it("should contain no runtime import loop", () => {
    const cycles = findImportCycles(graph);
    const report = cycles.map((c) => `loop:\n  ${c.join("\n  ")}`).join("\n");
    expect(cycles, cycles.length > 0 ? `${report}\nHint: ${HINT}` : "").toEqual(
      [],
    );
  });
});

function entryPoints(): string[] {
  return collectFiles().filter(
    (f) =>
      f === "bin/flow" ||
      (f.startsWith("bin/") &&
        (!f.slice(4).includes("/") ||
          fs.readFileSync(path.join(ROOT, f), "utf8").startsWith("#!"))),
  );
}

function hasImportMetaMain(file: string, source: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === "main"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("module-load lint: entry-point guard", () => {
  it("should not count a comment or string as import.meta.main", () => {
    expect(
      hasImportMetaMain(
        "a.ts",
        '// import.meta.main\nconst s = "import.meta.main";',
      ),
    ).toBe(false);
    expect(hasImportMetaMain("a.ts", "if (import.meta.main) {}")).toBe(true);
  });

  it("should require `import.meta.main` in every top-level bin script", () => {
    const missing = entryPoints().filter(
      (f) => !hasImportMetaMain(f, fs.readFileSync(path.join(ROOT, f), "utf8")),
    );
    expect(missing).toEqual([]);
  });
});

const bunOnPath = spawnSync("bun", ["--version"]).status === 0;

if (process.env.CI) {
  describe("module-load lint: bun availability", () => {
    it("should have bun on PATH in CI so the load sweep can never skip green", () => {
      expect(bunOnPath).toBe(true);
    });
  });
}

function loadTargets(): string[] {
  return entryPoints();
}

function loadOne(rel: string): Promise<string | null> {
  const env = { ...process.env };
  delete env.FLOW_SLUG;
  delete env.TMUX_PANE;
  return new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["-e", "await import(process.argv[1])", path.join(ROOT, rel)],
      { env, stdio: ["ignore", "ignore", "pipe"], cwd: ROOT },
    );
    let stderr = "";
    child.on("error", (err) => {
      resolve(`${rel}: spawn failed: ${err.message}`);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(null);
      const lines = stderr.split("\n").filter((l) => l.trim() !== "");
      const first =
        lines.find((l) => /\b\w*Error\b/.test(l)) ??
        lines[0] ??
        `exit ${code ?? signal}`;
      resolve(`${rel}: ${first}`);
    });
  });
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

describe.skipIf(!bunOnPath)("module-load lint: fresh-process load", () => {
  it(
    "should load every bin entry point in a fresh bun process",
    { timeout: 120_000 },
    async () => {
      const results = await mapConcurrent(loadTargets(), 8, loadOne);
      expect(results.filter((r): r is string => r !== null)).toEqual([]);
    },
  );
});
