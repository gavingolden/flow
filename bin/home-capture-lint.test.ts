import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as paths from "./lib/paths";
import { maskLiterals } from "./lib/source-mask";

/**
 * Always-run guard: no non-test module under bin/ resolves a home-derived path
 * at load time (a top-level `const X = flowDir()` freezes HOME before the
 * vitest sandbox swaps it, so the suite writes into the developer's real
 * `~/.flow`). Lives beside the other `bin/*-lint.test.ts` repo scans.
 */

const HOME_ACCESSORS = Object.entries(paths)
  .filter(
    ([name, value]) => typeof value === "function" && name !== "repoCacheKey",
  )
  .map(([name]) => name);

export type TopLevelHomeHit = { file: string; line: number; text: string };

function matching(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if ("([{".includes(text[k])) depth++;
    else if (")]}".includes(text[k]) && --depth === 0) return k;
  }
  return text.length - 1;
}

function arrowBodyEnd(text: string, from: number): number {
  let k = from;
  while (/\s/.test(text[k] ?? "")) k++;
  if (text[k] === "{") return matching(text, k) + 1;
  let depth = 0;
  for (; k < text.length; k++) {
    if ("([{".includes(text[k])) depth++;
    else if (")]}".includes(text[k])) {
      if (depth-- === 0) return k;
    } else if ((text[k] === "," || text[k] === ";") && depth === 0) return k;
  }
  return k;
}

/**
 * After a `)`, finds the `=>` or body `{` of a function whose parameter list
 * just closed, skipping an optional `: ReturnType` (which may contain `{}`,
 * `<>`, `[]`). Returns -1 when the `)` does not close a parameter list.
 */
function functionTail(
  text: string,
  from: number,
): { at: number; arrow: boolean } | null {
  let k = from;
  let sawColon = false;
  while (k < text.length) {
    if (/\s/.test(text[k])) k++;
    else if (text.startsWith("=>", k)) return { at: k, arrow: true };
    else if (text[k] === ":") {
      sawColon = true;
      k++;
    } else if (text[k] === "{") {
      let p = k - 1;
      while (p >= 0 && /\s/.test(text[p])) p--;
      if (p < from - 1 || !":|&<,(".includes(text[p]))
        return { at: k, arrow: false };
      k = matching(text, k) + 1;
    } else if (!sawColon) return null;
    else if ("([".includes(text[k])) k = matching(text, k) + 1;
    else if (text[k] === "<") {
      let d = 0;
      for (; k < text.length; k++) {
        if (text[k] === "<") d++;
        else if (text[k] === ">" && --d === 0) break;
      }
      k++;
    } else if (/[\w$.|&>\]'"`-]/.test(text[k])) k++;
    else return null;
  }
  return null;
}

/** Blanks parameter lists and bodies of arrows, `function`s, methods and getters. */
function blankFunctions(masked: string): string {
  const out = masked.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < masked.length) {
    if (masked.startsWith("=>", i)) {
      const end = arrowBodyEnd(masked, i + 2);
      blank(i, end);
      i = end;
    } else if (masked[i] === "(") {
      const close = matching(masked, i);
      const tail = functionTail(masked, close + 1);
      if (!tail) {
        i++;
        continue;
      }
      const end = tail.arrow
        ? arrowBodyEnd(masked, tail.at + 2)
        : matching(masked, tail.at) + 1;
      blank(i, end);
      i = end;
    } else i++;
  }
  return out.join("");
}

/**
 * Flags a home accessor / `os.homedir()` call inside a top-level
 * `const|let|var` initializer — including non-getter object-literal values —
 * while ignoring function parameter defaults and function bodies, which only
 * run when called. Statements other than declarations are out of scope.
 */
export function findTopLevelHomeReads(
  source: string,
  file: string,
  accessors: readonly string[] = HOME_ACCESSORS,
): TopLevelHomeHit[] {
  const code = blankFunctions(maskLiterals(source));
  const callRe = new RegExp(
    `(?<![\\w$.])(?:(?:paths\\.)?(?:${accessors.join("|")})|os\\.homedir|homedir)\\s*\\(|(?<![\\w$.])process\\.env\\.HOME\\b`,
  );
  const lines = source.split("\n");
  const hits: TopLevelHomeHit[] = [];
  const decl = /(?:^|[;}\n])\s*(?:export\s+)?(?:const|let|var)\s/g;
  for (let m = decl.exec(code); m; m = decl.exec(code)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let end = start;
    for (; end < code.length; end++) {
      const c = code[end];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === ";" && depth <= 0) break;
    }
    const hit = callRe.exec(code.slice(start, end));
    if (!hit) continue;
    const line = code.slice(0, start + hit.index).split("\n").length;
    hits.push({ file, line, text: lines[line - 1].trim() });
  }
  return hits;
}

function listNonTestSources(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => !f.split(path.sep).includes("node_modules"))
    .map((f) => path.join(dir, f));
}

describe("findTopLevelHomeReads", () => {
  const scan = (src: string) => findTopLevelHomeReads(src, "fixture.ts");

  it("flags an eager top-level initializer that calls a home accessor", () => {
    expect(scan('const X = path.join(flowStateDir(), "x");\n')).toHaveLength(1);
    expect(scan("export const H = os.homedir();\n")).toHaveLength(1);
    expect(
      scan("const T = {\n  a: 1,\n  b: localBinDir(),\n};\n")[0].line,
    ).toBe(3);
  });

  it("flags a top-level process.env.HOME read and a paths.-qualified call, not one inside a function", () => {
    expect(scan("const H = process.env.HOME;\n")).toHaveLength(1);
    expect(scan("const D = paths.flowStateDir();\n")).toHaveLength(1);
    expect(scan("const f = () => process.env.HOME;\n")).toEqual([]);
  });

  it("does not let a regex after return or => with unbalanced delimiters hide later reads", () => {
    const src = [
      "const f = (s: string) => /[(]/.test(s);",
      "function g(s: string) { return /\\(/.test(s); }",
      "const X = flowDir();",
    ].join("\n");
    expect(scan(src).map((h) => h.line)).toEqual([3]);
  });

  it("ignores default params, function bodies, getters, comments, and strings", () => {
    const src = [
      "const f = (slug: string, dir = flowStateDir()) => path.join(dir, slug);",
      "const g = (): string => { return flowDir(); };",
      "function h(d = localBinDir()) { return os.homedir(); }",
      "const T = { get a() { return flowDir(); } };",
      "// const c = flowDir();",
      'const s = "flowDir() and os.homedir()";',
      "const t = `${1 + 1} flowDir()`;",
      "const r = /flowDir\\(\\)/;",
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });
});

describe("no module resolves a home path at load time", () => {
  it("has no top-level initializer calling a home accessor in non-test bin/**/*.ts", () => {
    const binDir = path.resolve(__dirname);
    const hits = listNonTestSources(binDir).flatMap((file) =>
      findTopLevelHomeReads(
        fs.readFileSync(file, "utf8"),
        path.relative(binDir, file),
      ),
    );
    expect(hits.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });
});
