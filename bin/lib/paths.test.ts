/**
 * Direct, independently-derived contract tests for `bin/lib/paths.ts`'s
 * `repoCacheKey` plus a rename tripwire for the agent-memory constants.
 *
 * Every expectation below is computed inline from `node:crypto` /
 * `node:path` — never by calling `repoCacheKey` to build the expected
 * value. Deriving the expected value FROM the function under test would
 * make this suite pass even if the key formula, the realpath resolution,
 * or the truncation width silently drifted.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "./paths";
import { DEFAULT_TARGETS } from "./sources";
import {
  AGENT_MEMORY_DIRNAME,
  AGENT_MEMORY_RELPATH,
  flowRunAttributionLogPath,
  flowTelemetryLogPath,
  repoCacheKey,
} from "./paths";

function expectedKey(dir: string): string {
  const real = fs.realpathSync(dir);
  const base = path.basename(real);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

describe("repoCacheKey", () => {
  let dir!: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-repo-cache-key-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches the documented shape: <basename>-<8 hex chars>", () => {
    expect(repoCacheKey(dir)).toMatch(/^[^/]+-[0-9a-f]{8}$/);
  });

  it("equals basename(real) + '-' + sha256(real) truncated to 8 hex chars", () => {
    expect(repoCacheKey(dir)).toBe(expectedKey(dir));
  });

  it("resolves through a symlink to the same key as its real target", () => {
    const linkParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-repo-cache-key-link-"),
    );
    const linkPath = path.join(linkParent, "link-to-dir");
    fs.symlinkSync(dir, linkPath);
    try {
      expect(repoCacheKey(linkPath)).toBe(expectedKey(dir));
      expect(repoCacheKey(linkPath)).toBe(repoCacheKey(dir));
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("disambiguates two identically-named directories at different paths", () => {
    const parentA = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-repo-cache-key-a-"),
    );
    const parentB = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-repo-cache-key-b-"),
    );
    const dirA = path.join(parentA, "same-name");
    const dirB = path.join(parentB, "same-name");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    try {
      expect(path.basename(dirA)).toBe(path.basename(dirB));
      expect(repoCacheKey(dirA)).not.toBe(repoCacheKey(dirB));
      expect(repoCacheKey(dirA)).toBe(expectedKey(dirA));
      expect(repoCacheKey(dirB)).toBe(expectedKey(dirB));
    } finally {
      fs.rmSync(parentA, { recursive: true, force: true });
      fs.rmSync(parentB, { recursive: true, force: true });
    }
  });
});

describe("agent-memory constants (rename tripwire)", () => {
  // Deliberately hardcoded literals on BOTH sides — never
  // `AGENT_MEMORY_DIRNAME`/`AGENT_MEMORY_RELPATH` referenced against
  // themselves. A future rename of the constant's VALUE must fail this
  // test even though every call site still compiles and stays internally
  // consistent.
  it("AGENT_MEMORY_DIRNAME is the literal 'agent-memory-local'", () => {
    expect(AGENT_MEMORY_DIRNAME).toBe("agent-memory-local");
  });

  it("AGENT_MEMORY_RELPATH is the literal '.claude/agent-memory-local'", () => {
    expect(AGENT_MEMORY_RELPATH).toBe(".claude/agent-memory-local");
  });
});

describe("flowTelemetryLogPath", () => {
  it("resolves under the passed homeDir, not the real HOME", () => {
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "paths-telemetry-home-"),
    );
    try {
      const result = flowTelemetryLogPath(tmpHome);
      expect(result).toBe(
        path.join(tmpHome, ".flow", "telemetry", "events.jsonl"),
      );
      expect(result.startsWith(tmpHome)).toBe(true);
      expect(result).not.toContain(os.homedir());
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("defaults to the current home when no homeDir is passed", () => {
    expect(flowTelemetryLogPath()).toBe(
      path.join(os.homedir(), ".flow", "telemetry", "events.jsonl"),
    );
  });
});

describe("flowRunAttributionLogPath", () => {
  it("resolves under the passed homeDir", () => {
    expect(flowRunAttributionLogPath("/tmp/h")).toBe(
      path.join("/tmp/h", ".flow", "telemetry", "run-attribution.jsonl"),
    );
  });

  it("defaults to the current home when no homeDir is passed", () => {
    expect(flowRunAttributionLogPath()).toBe(
      path.join(os.homedir(), ".flow", "telemetry", "run-attribution.jsonl"),
    );
  });
});

const loadTimeHome = process.env.HOME as string;

const HOME_ACCESSORS = Object.entries(paths)
  .filter(
    ([name, value]) => typeof value === "function" && name !== "repoCacheKey",
  )
  .map(([name]) => name);

const pathFns = paths as unknown as Record<string, (...a: never[]) => unknown>;

const NOT_HOME_PATHS = new Set(["configuredFlowSource", "resolveFlowSource"]);

const ZERO_ARG_ACCESSORS = HOME_ACCESSORS.filter(
  (name) => !NOT_HOME_PATHS.has(name) && pathFns[name].length === 0,
);

describe("home-derived paths resolve at call time", () => {
  let laterHome!: string;

  beforeEach(() => {
    laterHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "paths-later-home-")),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(laterHome, { recursive: true, force: true });
  });

  it("follows a HOME change made after import", () => {
    vi.stubEnv("HOME", laterHome);

    for (const name of ZERO_ARG_ACCESSORS) {
      const resolved = pathFns[name]() as string;
      expect(resolved.startsWith(laterHome + path.sep), name).toBe(true);
    }
    expect(paths.installedHelperPath("flow").startsWith(laterHome)).toBe(true);
    expect(paths.resolveFlowSource()).toBeTypeOf("string");
    expect(paths.flowTelemetryLogPath().startsWith(laterHome)).toBe(true);
    for (const [key, value] of Object.entries(DEFAULT_TARGETS)) {
      expect(value.startsWith(laterHome + path.sep), key).toBe(true);
    }
  });

  it("exports no value captured from the import-time home", () => {
    for (const [name, value] of Object.entries(paths)) {
      if (typeof value !== "string") continue;
      expect(
        path.isAbsolute(value) && value.startsWith(loadTimeHome),
        name,
      ).toBe(false);
    }
  });
});

export type TopLevelHomeHit = { file: string; line: number; text: string };

const REGEX_PRECEDERS = "(,=:[!&|?{};";

/** Blanks comments and string/template/regex contents; keeps `${...}` code and offsets. */
function maskLiterals(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] !== "\n") out[k] = " ";
  };
  const template = () => {
    const start = ++i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(start, i);
        i += 2;
        code(true);
        return template2(i);
      } else i++;
    }
    blank(start, i);
    i++;
  };
  const template2 = (from: number) => {
    const start = from;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(start, i);
        i += 2;
        code(true);
        return template2(i);
      } else i++;
    }
    blank(start, i);
    i++;
  };
  let prev = "";
  const code = (untilCloseBrace: boolean) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? src.length : nl;
        blank(i, end);
        i = end;
      } else if (c === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        const end = close < 0 ? src.length : close + 2;
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'") {
        const start = ++i;
        while (i < src.length && src[i] !== c && src[i] !== "\n") {
          i += src[i] === "\\" ? 2 : 1;
        }
        blank(start, i);
        i++;
        prev = c;
      } else if (c === "`") {
        template();
        prev = "`";
      } else if (c === "/" && (prev === "" || REGEX_PRECEDERS.includes(prev))) {
        const start = ++i;
        let inClass = false;
        while (i < src.length && src[i] !== "\n") {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) break;
          i++;
        }
        blank(start, i);
        i++;
        prev = "/";
      } else {
        if (untilCloseBrace) {
          if (c === "{") depth++;
          else if (c === "}" && depth-- === 0) {
            i++;
            return;
          }
        }
        if (!/\s/.test(c)) prev = c;
        i++;
      }
    }
  };
  code(false);
  return out.join("");
}

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
    `(?<![\\w$.])(?:${accessors.join("|")}|os\\.homedir|homedir)\\s*\\(`,
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
    const binDir = path.resolve(__dirname, "..");
    const hits = listNonTestSources(binDir).flatMap((file) =>
      findTopLevelHomeReads(
        fs.readFileSync(file, "utf8"),
        path.relative(binDir, file),
      ),
    );
    expect(hits.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });
});
