import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint pinning that no pane-option read exists outside
 * `bin/lib/tmux.ts` and the named `@flow-kind` surfaces — in code *or* in
 * skill prose. Mirrors `bin/skill-md-lint.test.ts` /
 * `bin/slug-flag-contract-lint.test.ts`: read the tree, extract the
 * contract, assert the code honours it. No glob dependency — hand-rolled
 * `readdirSync(dir, { recursive: true })` + extension filters, same as
 * those two sibling lints (`picomatch` has a documented recurring failure
 * mode in this repo: a canonical checkout missing it degrades PATH helpers
 * silently).
 *
 * Detection is FILE-LEVEL, not line-windowed, by design: `bin/lib/tmux.ts`'s
 * own reads are multi-line `spawn([...])` array literals, so any fixed
 * lookahead window is one formatter reflow away from silently passing a
 * re-introduced pane read — the exact "green lint over a re-grown
 * violation" failure this lint exists to prevent. File-level detection
 * over-approximates in the safe direction: a file merely mentioning both
 * halves for unrelated reasons is flagged, and that flag is a one-line
 * allowlist review, not a silent miss.
 */

export type PaneReadViolation = { file: string; line: number; text: string };

// Long-form verbs plus tmux's own command aliases (`man tmux` ALIASES
// column): `show-options` -> `show`/`showo`; `show-window-options` ->
// `showw`; `list-windows` -> `lsw`; `display-message` -> `display`; plus
// `list-panes` -> `lsp`, since a pane enumeration read is equally a pane
// read. The short bare-word aliases (`show`, `display`) are quote-delimited
// (`"show"` / `'show'` / `` `show` ``) rather than `\b`-bounded: those two
// words are common English/identifier substrings (`showFoo`, "display the
// result"), so a bare-word match floods the frozen-set assertion with
// unrelated files — quoting them the same way a `spawn([...])` command-array
// literal actually spells the verb keeps the false-positive rate at the
// level the frozen-set test can still name one-by-one.
const READ_VERB_RE =
  /\bshow-options\b|["'`]showo["'`]|\bshow-window-options\b|["'`]showw["'`]|\blist-windows\b|["'`]lsw["'`]|\bdisplay-message\b|["'`]show["'`]|["'`]display["'`]|\blist-panes\b|["'`]lsp["'`]/;
const OPTION_TOKEN_RE =
  /@flow-[A-Za-z0-9_-]+|FLOW_SLUG_OPTION|FLOW_KIND_OPTION|FLOW_PHASE_OPTION|FLOW_PHASE_SHORT_OPTION|FLOW_REPO_OPTION|FLOW_EPIC_OPTION|FLOW_PR_OPTION/;

/**
 * A file is a violation when it contains a tmux read verb (`show-options`,
 * `list-windows`, `display-message`) ANYWHERE and also contains, ANYWHERE,
 * either a literal `@flow-<name>` token or one of the `FLOW_*_OPTION`
 * identifiers. `line`/`text` report the first read-verb line as a
 * best-effort locator — the VERDICT NEVER DEPENDS ON PROXIMITY between the
 * two halves.
 */
export function findPaneReads(
  files: { path: string; contents: string }[],
): PaneReadViolation[] {
  const violations: PaneReadViolation[] = [];
  for (const f of files) {
    if (!READ_VERB_RE.test(f.contents) || !OPTION_TOKEN_RE.test(f.contents)) {
      continue;
    }
    const lines = f.contents.split("\n");
    let line = 1;
    let text = "";
    for (let i = 0; i < lines.length; i++) {
      if (READ_VERB_RE.test(lines[i]!)) {
        line = i + 1;
        text = lines[i]!.trim();
        break;
      }
    }
    violations.push({ file: f.path, line, text });
  }
  return violations;
}

/**
 * Named paths only, each with an inline comment naming why, plus exactly
 * one prefix rule (trailing `/`). A pattern-shaped allowlist (`bin/**`,
 * `skills/**`, or a bare `*.test.ts` rule) is explicitly FORECLOSED — the
 * frozen-set assertion below is the entire value of this lint, and a
 * pattern would let a brand-new offending file pass silently. If the set
 * will not close, fix the offending file or add ONE named entry with an
 * inline reason; never widen a pattern.
 *
 * Verified against the tree at the time this lint landed (not the plan's
 * pre-scout prediction): Tasks 1-6+8's cleanup already removed the pane
 * dependency from `bin/lib/base-branch-guard.test.ts`,
 * `bin/lib/session-identity.test.ts`, and
 * `skills/pipeline/flow-pipeline/SKILL.md` entirely (SKILL.md's line-276
 * `display-message` counter-example survives, but the file now carries
 * ZERO `@flow-*` / `FLOW_*_OPTION` tokens anywhere else, so the AND-gated
 * detector does not flag it) — so none of the three need an allowlist
 * entry. Keeping them off the list is the CORRECT, tighter outcome: a
 * dead entry here would itself fail test 1 below (the resolved allowlist
 * set would no longer equal the real violation set).
 */
export const PANE_READ_ALLOWLIST: readonly string[] = [
  // The tmux backend module: owns every write and the two sanctioned reads
  // (the `@flow-kind` pane read via `resolveKindFromPane`, and the
  // `FLOW_SLUG_OPTION` window-enumeration read via `LIST_WINDOWS_FORMAT`).
  "bin/lib/tmux.ts",
  // Frozen historical hook bodies (v1-v4 all shelled out to tmux for the
  // slug); off-limits per AGENTS.md's version-drift lock discipline.
  "bin/lib/base-branch-guard-legacy.ts",
  // Covers resolveKindFromPane's own test — the sanctioned `@flow-kind`
  // exception's test-side half. base-branch-guard.test.ts and
  // session-identity.test.ts are deliberately NOT here (see the module doc
  // comment above) — a blanket `*.test.ts` rule is the deny-list shape
  // this lint exists to prevent.
  "bin/lib/tmux.test.ts",
  // This lint's own source: the negative-case fixtures below (test 5) MUST
  // contain literal read-verb + option-token text to exercise the checker,
  // so this file legitimately trips its own detector. Self-referential, not
  // a re-grown violation.
  "bin/pane-read-lint.test.ts",
  // Prefix rule: frozen rendered hook bytes (v1-v4 fixtures contain the
  // literal tmux read the guard body used to run; v5 has none and is not
  // flagged).
  "bin/fixtures/",
];

function isAllowlisted(relPath: string): boolean {
  return PANE_READ_ALLOWLIST.some((entry) =>
    entry.endsWith("/") ? relPath.startsWith(entry) : relPath === entry,
  );
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/** Recursively lists files under `rel` (relative to REPO_ROOT), skipping `node_modules`. When `exts` is omitted, every file is included (needed for `bin/` and `templates/`, which mix extensions — the `bin/fixtures/*.sh` hook fixtures are exactly why `bin/` cannot be `*.ts`-only). */
function filesUnder(rel: string, exts?: string[]): string[] {
  const dirPath = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { recursive: true, withFileTypes: true })
    .filter((d) => {
      if (!d.isFile()) return false;
      const dirName = (d.parentPath ?? d.path ?? "").split(path.sep);
      if (dirName.includes("node_modules")) return false;
      if (!exts) return true;
      return exts.some((e) => d.name.endsWith(e));
    })
    .map((d) =>
      path.relative(
        REPO_ROOT,
        path.join(d.parentPath ?? d.path ?? dirPath, d.name),
      ),
    );
}

function loadFiles(relPaths: string[]): { path: string; contents: string }[] {
  return relPaths.map((relPath) => ({
    path: relPath,
    contents: fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8"),
  }));
}

/** Non-recursive scan of repo-root files with a code/doc extension — `AGENTS.md`
 * used to be the only root file named explicitly, which made every OTHER
 * root-level file (e.g. `vitest.setup.ts`, the file this PR itself edits to
 * handle `TMUX_PANE`) invisible to the frozen-set assertion below. */
function rootFiles(): string[] {
  return fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|js|mjs|cjs|sh|md|json)$/.test(d.name))
    .map((d) => d.name);
}

/**
 * The full scanned surface: `bin/**` (every extension — see `filesUnder`'s
 * doc comment), `skills/**\/*.md`, `references/*.md` (the repo-root
 * `references/` dir; `skills/**\/*.md` already covers the per-skill ones
 * recursively), `docs/**\/*.md`, `agents/**\/*.md`, `templates/**`, and
 * every repo-ROOT file with a code/doc extension (non-recursive — a new
 * top-level DIRECTORY still needs a conscious `filesUnder(...)` addition
 * here, pinned by the surface test below).
 */
function scanSet(): string[] {
  const relPaths = [
    ...filesUnder("bin"),
    ...filesUnder("skills", [".md"]),
    ...filesUnder("references", [".md"]),
    ...filesUnder("docs", [".md"]),
    ...filesUnder("agents", [".md"]),
    ...filesUnder("templates"),
    ...rootFiles(),
  ];
  return [...new Set(relPaths)].sort();
}

/**
 * TASK 4 parity checks: pins that `bin/lib/tmux.ts`'s exported
 * `FLOW_*_OPTION` badge constants stay documented (DOCS PARITY), stay
 * published (PUBLISHER PARITY), and that no OTHER file writes `state.phase`
 * / `state.pr` without also publishing a badge for it (WRITE-SITE PARITY).
 * All three are file-content lints, same discipline as the pane-read
 * detector above: hand-rolled scanning, no glob/AST dependency (picomatch
 * has a documented recurring failure mode in this repo).
 */

/** Every `export const FLOW_*_OPTION = "@flow-*"` in bin/lib/tmux.ts. The
 * `export` anchor is load-bearing: `FLOW_SLUG_OPTION` is module-private and
 * must NOT be required to appear in either doc or `publishStateBadges`. */
function exportedFlowOptionConstants(): { name: string; value: string }[] {
  const contents = fs.readFileSync(
    path.join(REPO_ROOT, "bin/lib/tmux.ts"),
    "utf8",
  );
  const re = /export const (FLOW_[A-Z0-9_]+_OPTION) = "(@flow-[a-z-]+)"/g;
  const out: { name: string; value: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(contents))) {
    out.push({ name: m[1]!, value: m[2]! });
  }
  return out;
}

/** Extracts the balanced bracket span starting at `openIndex` (which must
 * hold `{`, `(`, or `[`), string-literal-aware. Used to carve out a
 * function's parameter list, a function/arrow body, or an object literal
 * without a full parser — the same "hand-rolled over a dependency" choice
 * this file already makes for pane-read detection. */
function extractBalanced(source: string, openIndex: number): string {
  const openChar = source[openIndex];
  const closeChar = openChar === "{" ? "}" : openChar === "(" ? ")" : "]";
  let depth = 0;
  let i = openIndex;
  for (; i < source.length; i++) {
    const ch = source[i];
    // Comments must be skipped BEFORE the quote check: a `//` comment
    // containing an apostrophe (e.g. "can't", "it's") is otherwise
    // misread as an open quote whose matching close-quote is found
    // arbitrarily far away, silently swallowing real braces in between
    // and desyncing the whole depth count.
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      i += 1; // land on the trailing '/'; the loop's i++ advances past it
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error(`unbalanced '${openChar}' from index ${openIndex}`);
}

/** Depth-aware: true only when the literal sets `phase:` or `pr:` at DEPTH
 * 1 of its OWN body (not nested inside a sub-object, and not a spread — a
 * spread token never matches the `IDENT:` shape). `expectKeyStart` gates
 * matching to "right after `{` or a depth-1 comma" so a value-position
 * ternary colon (`cond ? a : b`) can never be mistaken for a key. */
function literalSetsTopLevelPhaseOrPr(literal: string): boolean {
  let depth = 0;
  let expectKeyStart = false;
  let i = 0;
  const n = literal.length;
  while (i < n) {
    const ch = literal[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n && literal[i] !== quote) {
        if (literal[i] === "\\") i++;
        i++;
      }
      i++;
      expectKeyStart = false;
      continue;
    }
    if (ch === "/" && literal[i + 1] === "/") {
      while (i < n && literal[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && literal[i + 1] === "*") {
      i += 2;
      while (i < n && !(literal[i] === "*" && literal[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      if (depth === 1) expectKeyStart = true;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === ",") {
      if (depth === 1) expectKeyStart = true;
      i++;
      continue;
    }
    if (depth === 1 && expectKeyStart) {
      if (/^(phase|pr)\s*:/.exec(literal.slice(i))) return true;
      expectKeyStart = false;
      i++;
      continue;
    }
    i++;
  }
  return false;
}

/** Splits a `writeState(...)`'s inner argument text at the first
 * depth-0 (relative to this arg list) comma, string-literal-aware — the
 * call's first argument, verbatim. */
function splitTopLevelFirstArg(inner: string): string {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    // Same comment-before-quote ordering as extractBalanced — an
    // apostrophe inside an inline `//` comment must never be read as an
    // open quote.
    if (ch === "/" && inner[i + 1] === "/") {
      while (i < inner.length && inner[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && inner[i + 1] === "*") {
      i += 2;
      while (i < inner.length && !(inner[i] === "*" && inner[i + 1] === "/")) {
        i++;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < inner.length && inner[i] !== quote) {
        if (inner[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) return inner.slice(0, i);
  }
  return inner;
}

/** Locates a function's body by its unique signature marker (e.g.
 * `"export function publishStateBadges"`), skipping the parameter list AND
 * — when present — an object-type RETURN-TYPE annotation
 * (`): { ok: boolean; stderr: string } {`) that would otherwise be
 * mistaken for the body itself: the first `{` after the parameter list is
 * balanced-extracted, and if what immediately follows it is ALSO `{`, the
 * first extraction was the return-type annotation and the second is the
 * real body. */
function findFunctionBody(contents: string, sigMarker: string): string {
  const sigIdx = contents.indexOf(sigMarker);
  if (sigIdx === -1) {
    throw new Error(`signature '${sigMarker}' not found`);
  }
  const parenIdx = contents.indexOf("(", sigIdx);
  const params = extractBalanced(contents, parenIdx);
  let idx = contents.indexOf("{", parenIdx + params.length);
  let candidate = extractBalanced(contents, idx);
  let cursor = idx + candidate.length;
  while (/\s/.test(contents[cursor]!)) cursor++;
  if (contents[cursor] === "{") {
    idx = cursor;
    candidate = extractBalanced(contents, idx);
  }
  return candidate;
}

/** Same length as `source`, comments blanked to spaces (strings preserved
 * verbatim) so a REGEX match against the result can never land inside a
 * `//`/`/* *​/` comment — indices still line up 1:1 with the original for
 * a subsequent `extractBalanced` call. Needed because `bin/lib/feature.ts`
 * carries a doc comment illustrating `writeState(phase:"starting")` as
 * prose — a bare `\bwriteState\(` regex over raw source matches that
 * comment as a real call site. */
function stripCommentsPreserveLength(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        if (source[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Every `writeState(` call site in `bin/**\/*.ts` (excluding tests and
 * `bin/lib/state.ts`, `writeState`'s own definition file), paired with its
 * first-argument text verbatim. */
function findWriteStateCallSites(): {
  file: string;
  argText: string;
  /** ~80 chars of preceding context + the call's own raw text — exemption
   * markers are matched against THIS, not the whole file, so a file with
   * one legitimately-exempted call site can never accidentally shadow a
   * SECOND, genuinely-violating call site in the same file. */
  contextText: string;
}[] {
  const files = filesUnder("bin", [".ts"]).filter(
    (f) => !f.endsWith(".test.ts") && f !== "bin/lib/state.ts",
  );
  const sites: { file: string; argText: string; contextText: string }[] = [];
  for (const relPath of files) {
    const contents = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    const searchable = stripCommentsPreserveLength(contents);
    const re = /\bwriteState\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(searchable))) {
      const parenIdx = m.index + m[0].length - 1;
      let argsBlock: string;
      try {
        argsBlock = extractBalanced(contents, parenIdx);
      } catch {
        continue;
      }
      const inner = argsBlock.slice(1, -1);
      const callStart = m.index;
      const callEnd = parenIdx + argsBlock.length;
      sites.push({
        file: relPath,
        argText: splitTopLevelFirstArg(inner).trim(),
        contextText: contents.slice(Math.max(0, callStart - 80), callEnd),
      });
    }
  }
  return sites;
}

/** Resolves a bare `const NAME = { ... }` (optionally typed, `const NAME:
 * T = {`) same-file literal — the WRITE-SITE PARITY identifier-tracing
 * case. Returns `null` when NAME isn't defined as a same-file object
 * literal (e.g. it is a function parameter, like
 * `flow-seed-ingested-hook.ts`'s passthrough `saveState` wrapper — see
 * that file's named exemption below). */
function resolveIdentifierLiteral(
  fileContents: string,
  name: string,
): string | null {
  const idx = fileContents.search(
    new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`),
  );
  if (idx === -1) return null;
  const braceIdx = fileContents.indexOf("{", idx);
  try {
    return extractBalanced(fileContents, braceIdx);
  } catch {
    return null;
  }
}

/** Resolves a same-file helper's returned object literal for the
 * WRITE-SITE PARITY call-expression tracing case — handles both
 * `const NAME = (...) => ({ ... })` (arrow, parenthesized return, e.g.
 * `feature.ts`'s `makeBaseState`) and a traditional `function NAME(...) {
 * ... return { ... }; }` body. Returns `null` when NAME isn't a same-file
 * definition this shape-matches. */
function resolveCalleeLiteral(
  fileContents: string,
  name: string,
): string | null {
  const arrowIdx = fileContents.search(
    new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\(`),
  );
  if (arrowIdx !== -1) {
    const parenIdx = fileContents.indexOf("(", arrowIdx);
    try {
      const params = extractBalanced(fileContents, parenIdx);
      const afterParams = parenIdx + params.length;
      const arrowOpIdx = fileContents.indexOf("=>", afterParams);
      if (arrowOpIdx !== -1) {
        let j = arrowOpIdx + 2;
        while (/\s/.test(fileContents[j]!)) j++;
        if (fileContents[j] === "(") {
          const wrapParen = extractBalanced(fileContents, j);
          const braceIdx = wrapParen.indexOf("{");
          if (braceIdx !== -1) {
            return extractBalanced(fileContents, j + braceIdx);
          }
        } else if (fileContents[j] === "{") {
          const block = extractBalanced(fileContents, j);
          const retMatch = /return\s*\{/.exec(block);
          if (retMatch) {
            const braceIdx = j + retMatch.index! + retMatch[0].length - 1;
            return extractBalanced(fileContents, braceIdx);
          }
        }
      }
    } catch {
      // fall through to the traditional-function shape below
    }
  }
  const fnIdx = fileContents.search(
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
  );
  if (fnIdx !== -1) {
    try {
      const parenIdx = fileContents.indexOf("(", fnIdx);
      const params = extractBalanced(fileContents, parenIdx);
      const afterParams = parenIdx + params.length;
      const bodyOpen = fileContents.indexOf("{", afterParams);
      const body = extractBalanced(fileContents, bodyOpen);
      const retMatch = /return\s*\{/.exec(body);
      if (retMatch) {
        const braceIdx = bodyOpen + retMatch.index! + retMatch[0].length - 1;
        return extractBalanced(fileContents, braceIdx);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Classifies one `writeState(...)` call site's first-argument text and
 * resolves whether it sets a top-level `phase:`/`pr:` key. `"unresolved"`
 * (a bare identifier or helper call this file can't trace to a same-file
 * literal) is treated the SAME as `true` by the caller below — fail
 * closed, same discipline as `PANE_READ_ALLOWLIST`'s completeness
 * assertion: an unexplained site must be named, not silently passed. */
function callSiteSetsTopLevelPhaseOrPr(
  argText: string,
  fileContents: string,
): boolean | "unresolved" {
  if (argText.startsWith("{")) {
    return literalSetsTopLevelPhaseOrPr(argText);
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argText)) {
    const literal = resolveIdentifierLiteral(fileContents, argText);
    return literal === null
      ? "unresolved"
      : literalSetsTopLevelPhaseOrPr(literal);
  }
  const callMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(argText);
  if (callMatch) {
    const literal = resolveCalleeLiteral(fileContents, callMatch[1]!);
    return literal === null
      ? "unresolved"
      : literalSetsTopLevelPhaseOrPr(literal);
  }
  return "unresolved";
}

describe("pane-read-lint", () => {
  it("frozen file set: the set of files producing violations equals PANE_READ_ALLOWLIST's resolved set", () => {
    const files = loadFiles(scanSet());
    const violatingPaths = new Set(findPaneReads(files).map((v) => v.file));
    const namedEntries = PANE_READ_ALLOWLIST.filter((e) => !e.endsWith("/"));
    const prefixEntries = PANE_READ_ALLOWLIST.filter((e) => e.endsWith("/"));

    // Completeness: a NEW file with a pane read fails by default — every
    // violation must be explained by a named or prefix allowlist entry.
    const unexplained = [...violatingPaths].filter((p) => !isAllowlisted(p));
    expect(
      unexplained,
      "new pane-read violation(s) not covered by PANE_READ_ALLOWLIST — fix " +
        "the offending file or add ONE named entry with an inline reason",
    ).toEqual([]);

    // No dead named entries: each named path must itself be a real
    // violation today, or it is stale cargo the allowlist should shed.
    const deadNamed = namedEntries.filter((e) => !violatingPaths.has(e));
    expect(
      deadNamed,
      "PANE_READ_ALLOWLIST names a file that no longer produces a " +
        "violation — remove the dead entry",
    ).toEqual([]);

    // No dead prefix entries: each prefix must match at least one real
    // violation.
    for (const prefix of prefixEntries) {
      const matches = [...violatingPaths].filter((p) => p.startsWith(prefix));
      expect(
        matches.length,
        `PANE_READ_ALLOWLIST's prefix entry '${prefix}' matches no violation`,
      ).toBeGreaterThan(0);
    }
  });

  it("allowlist shape: named entries are concrete file paths, at most one prefix entry, no broad prefixes", () => {
    // Pins the two regressions that pass every OTHER assertion in this file:
    // (1) a future maintainer widening a named entry into a broad prefix
    // (`"bin/"`, `"skills/"`) still trivially satisfies completeness /
    // dead-entry / prefix-match-count, silently un-freezing the set; (2) see
    // the next test for the matcher-drift half.
    const prefixes = PANE_READ_ALLOWLIST.filter((e) => e.endsWith("/"));
    expect(prefixes.length).toBeLessThanOrEqual(1);
    for (const e of prefixes) {
      expect(
        e.split("/").filter(Boolean).length,
        `prefix '${e}' is too broad`,
      ).toBeGreaterThan(1);
    }
    for (const e of PANE_READ_ALLOWLIST.filter((x) => !x.endsWith("/"))) {
      expect(e, `named entry '${e}' must be a concrete file path`).toMatch(
        /\.[a-z]+$/,
      );
    }
  });

  it("fails closed for a new file: exact match for named entries, prefix only for the trailing-slash rule", () => {
    // The matcher-drift half of the regression above: if `isAllowlisted`'s
    // named-entry arm ever changed from `===` to `startsWith`, this is the
    // assertion that would catch a stray `.orig`/`.bak` sneaking through.
    expect(isAllowlisted("bin/lib/session-identity.ts")).toBe(false);
    expect(isAllowlisted("bin/lib/tmux.ts.orig")).toBe(false);
    expect(isAllowlisted("bin/fixtures/base-branch-guard-v6.sh")).toBe(true);
  });

  it("scanned surface includes repo-root files (not just the hard-coded AGENTS.md)", () => {
    // Reachable, not hypothetical: vitest.setup.ts is a repo-root file this
    // very PR edits to handle TMUX_PANE, and a hard-coded single-file root
    // scan would leave it (and any future root-level pane read) invisible to
    // the frozen-set assertion above.
    const scanned = new Set(scanSet());
    expect(scanned.has("AGENTS.md")).toBe(true);
    expect(scanned.has("vitest.setup.ts")).toBe(true);
    expect(scanned.has("package.json")).toBe(true);
  });

  it("no prose reads: zero matches of 'tmux show-options' across skills/**/*.md, references/*.md, docs/**/*.md, agents/**/*.md, AGENTS.md", () => {
    const relPaths = [
      ...filesUnder("skills", [".md"]),
      ...filesUnder("references", [".md"]),
      ...filesUnder("docs", [".md"]),
      ...filesUnder("agents", [".md"]),
    ];
    if (fs.existsSync(path.join(REPO_ROOT, "AGENTS.md"))) {
      relPaths.push("AGENTS.md");
    }
    const offenders = loadFiles(relPaths).filter((f) =>
      f.contents.includes("tmux show-options"),
    );
    expect(
      offenders.map((f) => f.path),
      "prose containing a literal 'tmux show-options' read survived the migration",
    ).toEqual([]);
  });

  it("slug read is gone: bin/lib/tmux.ts contains no resolveSlugFromPane, and its only show-options call targets FLOW_KIND_OPTION", () => {
    const contents = fs.readFileSync(
      path.join(REPO_ROOT, "bin/lib/tmux.ts"),
      "utf8",
    );
    expect(contents).not.toContain("resolveSlugFromPane");
    // Scoped to the actual CALL sites (a quoted JS string literal), not
    // prose mentions in doc comments (which quote it in backticks).
    const showOptionsCalls = contents
      .split("\n")
      .filter((l) => l.includes('"show-options"'));
    expect(showOptionsCalls.length).toBeGreaterThan(0);
    for (const l of showOptionsCalls) {
      expect(l).toContain("FLOW_KIND_OPTION");
    }
  });

  it("epic exception is intact and bidirectional", () => {
    const sessionIdentity = fs.readFileSync(
      path.join(REPO_ROOT, "bin/lib/session-identity.ts"),
      "utf8",
    );
    expect(sessionIdentity).toContain("resolveKindAmbient");
    expect(sessionIdentity).toContain("tmux-only");
    const epic = fs.readFileSync(
      path.join(REPO_ROOT, "bin/lib/epic.ts"),
      "utf8",
    );
    expect(epic).toContain("resolveKindAmbient");
  });

  it("docs parity: every exported FLOW_*_OPTION value is documented in both AGENTS.md and docs/configuration.md", () => {
    const constants = exportedFlowOptionConstants();
    // Sanity: the extractor itself must find at least the long-standing
    // constants, or this assertion would vacuously pass on a broken regex.
    expect(constants.map((c) => c.name)).toEqual(
      expect.arrayContaining(["FLOW_PHASE_OPTION", "FLOW_PR_OPTION"]),
    );
    expect(
      constants.some((c) => c.name === "FLOW_SLUG_OPTION"),
      "FLOW_SLUG_OPTION is module-private (not `export const`) and must NOT be required in docs",
    ).toBe(false);
    const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    const config = fs.readFileSync(
      path.join(REPO_ROOT, "docs/configuration.md"),
      "utf8",
    );
    const missing = constants
      .filter((c) => !agents.includes(c.value) || !config.includes(c.value))
      .map((c) => c.name);
    expect(
      missing,
      "a new exported FLOW_*_OPTION badge must be documented in both AGENTS.md and docs/configuration.md before it ships",
    ).toEqual([]);
  });

  // FLOW_REPO_OPTION is seeded ONCE at window creation by `seedWindowOptions`
  // (bin/lib/tmux.ts) and deliberately never republished — repo identity
  // never changes across a pipeline's lifetime. Verified against the tree:
  // it is genuinely absent from publishStateBadges's body today, so an
  // unexempted check here would FALSE-FAIL on correct code.
  const PUBLISHER_PARITY_EXEMPTIONS: readonly string[] = ["FLOW_REPO_OPTION"];

  it("publisher parity: every exported FLOW_*_OPTION identifier is referenced inside publishStateBadges's body, except the named creation-only exemption", () => {
    const contents = fs.readFileSync(
      path.join(REPO_ROOT, "bin/lib/tmux.ts"),
      "utf8",
    );
    const constants = exportedFlowOptionConstants();
    expect(constants.length).toBeGreaterThan(0);
    const body = findFunctionBody(
      contents,
      "export function publishStateBadges",
    );

    const missing = constants
      .filter((c) => !PUBLISHER_PARITY_EXEMPTIONS.includes(c.name))
      .filter((c) => !body.includes(c.name))
      .map((c) => c.name);
    expect(
      missing,
      "a new exported FLOW_*_OPTION must be published inside publishStateBadges, or named in PUBLISHER_PARITY_EXEMPTIONS with a reason",
    ).toEqual([]);

    // Dead-exemption guard: an exemption that now IS published is stale.
    const staleExemptions = PUBLISHER_PARITY_EXEMPTIONS.filter((name) =>
      body.includes(name),
    );
    expect(
      staleExemptions,
      "PUBLISHER_PARITY_EXEMPTIONS names an option that publishStateBadges now publishes — remove the stale exemption",
    ).toEqual([]);
  });

  // Frozen, named write-site exemption set — same discipline as
  // PANE_READ_ALLOWLIST: one entry per legitimate top-level phase:/pr:
  // write outside phase-advance.ts/flow-state-update.ts, each with an
  // inline reason, verified against the tree (not the plan's prediction).
  const WRITE_SITE_PARITY_FILE_EXEMPT = new Set([
    "bin/lib/phase-advance.ts",
    "bin/flow-state-update.ts",
  ]);
  const WRITE_SITE_PARITY_EXEMPTIONS: readonly {
    file: string;
    marker: string;
    reason: string;
  }[] = [
    {
      file: "bin/lib/epic.ts",
      marker: 'phase: "starting"',
      reason:
        "epic-design creation write — seedWindowOptions (bin/lib/tmux.ts) already seeds @flow-phase at window creation, so this creation-path write is legitimately never republished.",
    },
    {
      file: "bin/lib/feature.ts",
      marker: 'writeState(makeBaseState("plain")',
      reason:
        'creation-path write via makeBaseState (same-file helper whose object literal sets phase: "starting") — seedWindowOptions already seeds @flow-phase at window creation.',
    },
    {
      file: "bin/flow-seed-ingested-hook.ts",
      marker: "saveState: (state) => writeState(state)",
      reason:
        "passthrough dependency-injection wrapper — its `state` parameter is not a same-file object literal the tracer can resolve; the one real call site (`deps.saveState({ ...fresh, seedIngest })`) was manually verified to carry no top-level phase/pr key, so this definition site is exempted as out of the depth-aware tracer's reach.",
    },
  ];

  it("write-site parity: every writeState(...) call setting a top-level phase:/pr: key lives in phase-advance.ts/flow-state-update.ts, or is a named exemption", () => {
    const sites = findWriteStateCallSites();
    expect(sites.length).toBeGreaterThan(0);
    const fileContentsCache = new Map<string, string>();
    const violations: string[] = [];
    for (const site of sites) {
      if (WRITE_SITE_PARITY_FILE_EXEMPT.has(site.file)) continue;
      if (!fileContentsCache.has(site.file)) {
        fileContentsCache.set(
          site.file,
          fs.readFileSync(path.join(REPO_ROOT, site.file), "utf8"),
        );
      }
      const contents = fileContentsCache.get(site.file)!;
      const verdict = callSiteSetsTopLevelPhaseOrPr(site.argText, contents);
      if (verdict === false) continue;
      // Scoped to THIS call site's own context, not the whole file — a
      // file-wide `contents.includes(...)` would let one legitimately
      // exempted call site silently shadow a second, genuinely-violating
      // call site elsewhere in the same file.
      const exemption = WRITE_SITE_PARITY_EXEMPTIONS.find(
        (e) => e.file === site.file && site.contextText.includes(e.marker),
      );
      if (exemption) continue;
      violations.push(`${site.file}: ${site.argText.slice(0, 60)}`);
    }
    expect(
      violations,
      "a writeState(...) call sets a top-level phase:/pr: key outside " +
        "phase-advance.ts/flow-state-update.ts with no named exemption — " +
        "move the write there, add a publishBadges seam, or name a " +
        "reviewed exemption in WRITE_SITE_PARITY_EXEMPTIONS",
    ).toEqual([]);

    // Dead-exemption guard: each exemption's marker must still be present.
    for (const e of WRITE_SITE_PARITY_EXEMPTIONS) {
      const contents = fs.readFileSync(path.join(REPO_ROOT, e.file), "utf8");
      expect(
        contents.includes(e.marker),
        `WRITE_SITE_PARITY_EXEMPTIONS entry for ${e.file} is stale — marker '${e.marker}' no longer found`,
      ).toBe(true);
    }
  });

  describe("findPaneReads negative cases", () => {
    it("catches a literal tmux show-options pane-slug read", () => {
      const violations = findPaneReads([
        {
          path: "synthetic/a.ts",
          contents: `SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)`,
        },
      ]);
      expect(violations.length).toBe(1);
      expect(violations[0]!.file).toBe("synthetic/a.ts");
    });

    it("catches a spawn([...]) read reflowed across 6+ lines with 20 blank/comment lines between the verb and the constant (reflow-immunity case)", () => {
      const filler = Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? "" : `// unrelated comment line ${i}`,
      ).join("\n");
      const contents = [
        `const r = spawn([`,
        `  "show-options",`,
        filler,
        `  "-w",`,
        `  "-t",`,
        `  pane,`,
        `  FLOW_SLUG_OPTION,`,
        `]);`,
      ].join("\n");
      const violations = findPaneReads([{ path: "synthetic/b.ts", contents }]);
      expect(
        violations.length,
        "a line-windowed detector would miss this — the verb and the option " +
          "constant are 20+ lines apart",
      ).toBe(1);
    });

    it("catches a list-windows format string reading the slug option", () => {
      const violations = findPaneReads([
        {
          path: "synthetic/c.ts",
          contents: `tmux(["list-windows", "-F", "#{@flow-slug}"]);`,
        },
      ]);
      expect(violations.length).toBe(1);
    });

    it("catches tmux's short-form alias `showw` (show-window-options) reading @flow-kind, not just the long-form verb", () => {
      const violations = findPaneReads([
        {
          path: "synthetic/f.ts",
          contents: `tmux(["showw", "-v", "@flow-kind"]);`,
        },
      ]);
      expect(
        violations.length,
        "a lint that only matches the long-form verb name lets the same " +
          "read spelled with tmux's own alias evade the frozen-set guard",
      ).toBe(1);
    });

    it("returns [] for prose mentioning @flow-phase with no read verb anywhere", () => {
      const violations = findPaneReads([
        {
          path: "synthetic/d.md",
          contents:
            "Bind `#{@flow-phase}` into your own tmux status-bar format.",
        },
      ]);
      expect(violations).toEqual([]);
    });

    it("returns [] for a file with a read verb but no option token", () => {
      const violations = findPaneReads([
        {
          path: "synthetic/e.ts",
          contents: `tmux(["display-message", "-p", "#{window_id}"]);`,
        },
      ]);
      expect(violations).toEqual([]);
    });
  });
});
