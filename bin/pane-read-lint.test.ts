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

const READ_VERB_RE = /show-options|list-windows|display-message/;
const OPTION_TOKEN_RE =
  /@flow-[A-Za-z0-9_-]+|FLOW_SLUG_OPTION|FLOW_KIND_OPTION|FLOW_PHASE_OPTION|FLOW_PHASE_SHORT_OPTION|FLOW_REPO_OPTION|FLOW_EPIC_OPTION/;

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

/**
 * The full scanned surface: `bin/**` (every extension — see `filesUnder`'s
 * doc comment), `skills/**\/*.md`, `references/*.md` (the repo-root
 * `references/` dir; `skills/**\/*.md` already covers the per-skill ones
 * recursively), `docs/**\/*.md`, `agents/**\/*.md`, `templates/**`, and
 * `AGENTS.md`.
 */
function scanSet(): string[] {
  const relPaths = [
    ...filesUnder("bin"),
    ...filesUnder("skills", [".md"]),
    ...filesUnder("references", [".md"]),
    ...filesUnder("docs", [".md"]),
    ...filesUnder("agents", [".md"]),
    ...filesUnder("templates"),
  ];
  if (fs.existsSync(path.join(REPO_ROOT, "AGENTS.md"))) {
    relPaths.push("AGENTS.md");
  }
  return [...new Set(relPaths)].sort();
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
