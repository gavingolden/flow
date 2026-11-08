import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { maskLiterals } from "./lib/source-mask";

/**
 * A test that launches a child with an explicit `env: { ... }` literal that
 * carries neither a `HOME` key nor a `...process.env` spread hands the child
 * no sandbox HOME, so the child resolves the account's real home and writes
 * into the developer's real `~/.flow` (precedent: flow-delegate tests wrote
 * ~1,770 agy-not-found telemetry rows there). This lint flags such literals.
 *
 * Scope: only inline `env:` OBJECT LITERALS inside spawn-family calls. A
 * non-literal `env` value (a variable or helper call such as
 * `env: env ?? ISOLATED_ENV`) is out of scope — the lint cannot follow it.
 * Same hand-rolled balanced-paren scan as bin/pane-read-lint.test.ts: no glob
 * dependency.
 */

export type HomelessChildEnv = { file: string; line: number; text: string };

const SPAWN_CALL_RE =
  /(?:(?<![\w$.])Bun\.spawn(?:Sync)?|(?<![\w$.])(?:child_process\.)?(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)|(?<![\w$.])execa)\s*\(/g;
const SELF = path.join("bin", "test-subprocess-home-lint.test.ts");

function matchingClose(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if ("([{".includes(text[k])) depth++;
    else if (")]}".includes(text[k]) && --depth === 0) return k;
  }
  return text.length - 1;
}

/** Structure is found in `masked`; the body text returned is from `call` (same offsets). */
function envLiteralBodies(call: string, masked: string): string[] {
  const bodies: string[] = [];
  const re = /(?<![\w$.])env\s*:\s*\{/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    bodies.push(call.slice(open + 1, matchingClose(masked, open)));
  }
  return bodies;
}

function lacksHome(body: string): boolean {
  const homeProp = /(?<![\w$.])HOME(?:\s*:\s*([^,}\n]*)|\s*(?:,|$))/.exec(body);
  if (homeProp) {
    if (homeProp[1] === undefined) return false;
    const value = homeProp[1].trim();
    return (
      value === "" ||
      value === "undefined" ||
      value === '""' ||
      value === "''" ||
      value === "``"
    );
  }
  return !/\.\.\.\s*process\.env\b/.test(body);
}

export function findHomelessChildEnvs(
  source: string,
  file: string,
): HomelessChildEnv[] {
  const hits: HomelessChildEnv[] = [];
  const lines = source.split("\n");
  const masked = maskLiterals(source);
  SPAWN_CALL_RE.lastIndex = 0;
  for (let m = SPAWN_CALL_RE.exec(masked); m; m = SPAWN_CALL_RE.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const end = matchingClose(masked, open) + 1;
    const call = source.slice(open, end);
    for (const body of envLiteralBodies(call, masked.slice(open, end))) {
      if (lacksHome(body)) {
        const line = source.slice(0, m.index).split("\n").length;
        hits.push({ file, line, text: lines[line - 1].trim() });
      }
    }
  }
  return hits;
}

function trackedTestFiles(root: string): string[] {
  const found: string[] = [];
  for (const dir of ["bin", "scripts", "skills", "docs", "evals"]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const rel of fs.readdirSync(abs, { recursive: true }) as string[]) {
      const parts = rel.split(path.sep);
      if (!rel.endsWith(".test.ts") || parts.includes("node_modules")) continue;
      found.push(path.join(dir, rel));
    }
  }
  return found.filter((f) => f !== SELF);
}

describe("findHomelessChildEnvs", () => {
  const scan = (src: string) => findHomelessChildEnvs(src, "fixture.test.ts");

  it("flags env literals with no HOME and no process.env spread", () => {
    expect(
      scan('spawnSync("bun", [], { env: { PATH: "/bin" } });'),
    ).toHaveLength(1);
    expect(scan('spawnSync("bun", [], { env: { ...base } });')).toHaveLength(1);
  });

  it("flags an explicitly unset or empty HOME even with a process.env spread", () => {
    expect(
      scan(
        'spawnSync("bun", [], { env: { ...process.env, HOME: undefined } });',
      ),
    ).toHaveLength(1);
    expect(
      scan('spawnSync("bun", [], { env: { ...process.env, HOME: "" } });'),
    ).toHaveLength(1);
  });

  it("passes env literals that inherit or set HOME", () => {
    expect(scan('spawnSync("bun", [], { env: { ...process.env } });')).toEqual(
      [],
    );
    expect(
      scan('spawnSync("bun", [], { env: { PATH: "/bin", HOME: h } });'),
    ).toEqual([]);
  });

  it("accepts shorthand HOME and ignores RegExp.exec and spawn text in comments/strings", () => {
    expect(
      scan('spawnSync("bun", [], { env: { HOME, PATH: "/bin" } });'),
    ).toEqual([]);
    expect(scan("re.exec(x); foo({ env: { PATH: 1 } });")).toEqual([]);
    expect(scan('// spawnSync("a", { env: { PATH: 1 } })')).toEqual([]);
  });

  it("is not thrown off by unbalanced parens inside string args", () => {
    expect(
      scan(
        'spawnSync("sh", ["-c", "case $x in a) ;; esac"], { env: { PATH: "/bin" } });',
      ),
    ).toHaveLength(1);
  });

  it("ignores non-literal env values and non-spawn calls", () => {
    expect(scan('spawnSync("bun", [], { env: makeEnv() });')).toEqual([]);
    expect(scan("foo({ env: { PATH: 1 } });")).toEqual([]);
  });
});

describe("test subprocess HOME lint", () => {
  it("every spawn-family env literal in tracked tests carries HOME or spreads process.env", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const hits = trackedTestFiles(root).flatMap((file) =>
      findHomelessChildEnvs(
        fs.readFileSync(path.join(root, file), "utf8"),
        file,
      ),
    );
    expect(hits.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });
});
