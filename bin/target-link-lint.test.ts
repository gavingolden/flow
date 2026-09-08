import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint pinning that no NEW site emits a bare click-target
 * (a PR URL, an issue URL, a worktree/plan-file/screenshot path) without
 * going through `bin/lib/link.ts` or a markdown link labelled with the
 * raw target. Mirrors `bin/pane-read-lint.test.ts`: file-level (not
 * line-windowed) detection, hand-rolled `readdirSync(dir, { recursive:
 * true })`, no glob dependency (`picomatch` has a documented recurring
 * failure mode in this repo — a canonical checkout missing it degrades
 * PATH helpers silently, see `bin/pane-read-lint.test.ts:6-15`).
 *
 * Detection is FILE-LEVEL and over-approximates in the safe direction: a
 * file that emits to stdout AND separately mentions one of the tracked
 * identifiers for an unrelated reason (e.g. `fs.existsSync(worktreeDir)`,
 * never printed) is flagged, and that flag is a one-line allowlist
 * review, not a silent miss. The frozen-set assertion below is the
 * entire value of this lint — a NEW file tripping the detector fails by
 * default until it earns a named, reasoned allowlist entry (or the
 * emission is fixed to go through `bin/lib/link.ts`).
 */

export type BareTargetViolation = { file: string; line: number; text: string };

const EMIT_RE = /console\.log|process\.stdout\.write/;
const TARGET_RE =
  /\bprUrl\b|\bissueUrl\b|\bworktreeDir\b|\bplanFile\b|\bscreenshotPath\b|\bpr\.url\b/;

/**
 * A file is a violation when it contains a stdout-emitting call ANYWHERE
 * and ALSO mentions one of the tracked target identifiers ANYWHERE.
 * `line`/`text` report the first EMIT_RE line as a best-effort locator —
 * the verdict never depends on proximity between the two halves (same
 * discipline as `bin/pane-read-lint.test.ts`'s `findPaneReads`).
 */
export function findBareTargets(root: string): BareTargetViolation[] {
  const violations: BareTargetViolation[] = [];
  for (const relPath of scanBinTs(root)) {
    const contents = fs.readFileSync(path.join(root, relPath), "utf8");
    if (!EMIT_RE.test(contents) || !TARGET_RE.test(contents)) continue;
    const lines = contents.split("\n");
    let line = 1;
    let text = "";
    for (let i = 0; i < lines.length; i++) {
      if (EMIT_RE.test(lines[i]!)) {
        line = i + 1;
        text = lines[i]!.trim();
        break;
      }
    }
    violations.push({ file: relPath, line, text });
  }
  return violations;
}

/** Recursively lists `.ts` files under `bin/`, skipping `*.test.ts` and `bin/fixtures/`. */
function scanBinTs(root: string): string[] {
  const dirPath = path.join(root, "bin");
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { recursive: true, withFileTypes: true })
    .filter((d) => {
      if (!d.isFile()) return false;
      if (!d.name.endsWith(".ts")) return false;
      if (d.name.endsWith(".test.ts")) return false;
      // `Dirent.parentPath` landed in Node 20.12; `engines.node` declares
      // `>=20`, so fall back to the older `.path` the way every sibling walk
      // in this repo does (bin/pane-read-lint.test.ts, bin/lib/setup.test.ts).
      const dirName = (d.parentPath ?? d.path ?? "").split(path.sep);
      if (dirName.includes("fixtures")) return false;
      return true;
    })
    .map((d) =>
      path.relative(root, path.join(d.parentPath ?? d.path ?? "", d.name)),
    )
    .sort();
}

/**
 * Named paths only, each with an inline reason — no pattern-shaped entry
 * (`bin/**`, a bare `*.ts` rule). Built from an ACTUAL run of
 * `findBareTargets` against the tree at the time this lint landed, not a
 * pre-scout prediction: file-level detection over-approximates, so most
 * of these are false positives by design (the tracked identifier is
 * mentioned for a `fs`/`path` reason, never printed to stdout) rather
 * than a real bare-target emission this lint should have blocked.
 * `bin/flow-create-issue.ts` is deliberately ABSENT — it writes
 * `JSON.stringify(out)`, and the string `issueUrl` never appears in that
 * file, so it does not trip the detector; naming it here would make the
 * frozen-set test fail on a dead entry (test 1 below).
 */
export const BARE_TARGET_ALLOWLIST: readonly string[] = [
  // Reads worktreeDir with fs.existsSync — never printed.
  "bin/lib/worktree-fs.ts",
  // console.log'd rows come from printTable's line-joined cells, already
  // routed through bin/lib/link.ts's linkLabel/linkPath (Task 5's own
  // fix) — the file's *own* `prUrl` mentions are the Row field and the
  // buildRows assignment, never a bare print.
  "bin/lib/ls.ts",
  // console.log(pr.url) is the entire sanctioned bare-URL stdout contract
  // (OFF-LIMITS per this PR's own edit-set) — `/flow-pipeline` step 5
  // reads it as a bare line, and it must never be linkified.
  "bin/flow-open-pr.ts",
  // Emits progress/status lines that separately mention `planFile` (a
  // local variable name for the plan-file path arg) — the actual
  // gate-summary click targets are linkified via bin/lib/link.ts; this
  // file's own console.log calls are unrelated status prose.
  "bin/flow-gate-summary.ts",
  // Emits `NOTICE —`/status lines to stdout and separately reads
  // `worktreeDir`/`planFile` local variables for file I/O — no bare
  // click target is printed from this file.
  "bin/flow-research-note.ts",
  // Emits progress output to stdout and separately reads `worktreeDir`
  // for filesystem operations (removal) — never printed.
  "bin/flow-remove-worktree.ts",
  // Emits progress/status lines to stdout and separately reads
  // `screenshotPath` for filesystem checks — never printed bare.
  "bin/flow-ui-validate.ts",
  // Emits result prose to stdout and separately mentions `planFile` in a
  // local variable/comment — no bare click target is printed here.
  "bin/flow-plan-review.ts",
  // Emits `JSON.stringify(result)` — prUrl travels inside a structured
  // JSON payload, never as a bare printed line.
  "bin/flow-gate-decide.ts",
  // Emits progress output to stdout and separately reads `worktreeDir`
  // for filesystem setup — never printed bare.
  "bin/flow-new-worktree.ts",
  // Emits its rendered blocks via `process.stdout.write`, but the actual
  // `prUrl`/`planFile` click targets in those blocks are already routed
  // through `renderEchoRecap` (bin/lib/link.ts, markdown mode) before
  // this file ever touches them — this file's own local `prUrl`/
  // `planFile` variables are pass-through params, not print sites.
  "bin/flow-pipeline-summary.ts",
  // Emits probe/status prose to stdout and separately mentions `prUrl`
  // in maintainer-only probe output, not a bare click target.
  "bin/flow-plugin-probe.ts",
  // `console.log(HELP)` (unrelated) plus `process.stdout.write(serialized)`
  // — prUrl travels inside the serialized JSON status payload, never as a
  // bare printed line.
  "bin/flow-ci-check.ts",
];

function isAllowlisted(relPath: string): boolean {
  return BARE_TARGET_ALLOWLIST.some((entry) => entry === relPath);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// Scanned once at module scope: the walk reads every `.ts` under `bin/`, and
// both repo-wide tests below assert over the same immutable result. Matches
// how bin/pane-read-lint.test.ts loads its scan surface exactly once.
const REPO_VIOLATIONS = findBareTargets(REPO_ROOT);

describe("target-link-lint", () => {
  it("frozen file set: the set of files producing violations equals BARE_TARGET_ALLOWLIST", () => {
    const violatingPaths = new Set(REPO_VIOLATIONS.map((v) => v.file));

    // Completeness: a NEW file tripping the detector fails by default —
    // every violation must be explained by a named allowlist entry.
    const unexplained = [...violatingPaths].filter((p) => !isAllowlisted(p));
    expect(
      unexplained,
      "new bare-target violation(s) not covered by BARE_TARGET_ALLOWLIST — " +
        "route the emission through bin/lib/link.ts, or add ONE named " +
        "entry with an inline reason",
    ).toEqual([]);

    // No dead entries: each named path must itself be a real violation
    // today, or it is stale cargo the allowlist should shed.
    const dead = BARE_TARGET_ALLOWLIST.filter((e) => !violatingPaths.has(e));
    expect(
      dead,
      "BARE_TARGET_ALLOWLIST names a file that no longer produces a " +
        "violation — remove the dead entry",
    ).toEqual([]);
  });

  it("bin/flow-create-issue.ts is deliberately absent (does not trip the detector)", () => {
    expect(
      REPO_VIOLATIONS.some((v) => v.file === "bin/flow-create-issue.ts"),
    ).toBe(false);
  });

  it("allowlist shape: every entry is a concrete .ts path, never a pattern", () => {
    for (const e of BARE_TARGET_ALLOWLIST) {
      expect(e.endsWith(".ts")).toBe(true);
      expect(e).not.toContain("*");
    }
  });

  describe("findBareTargets negative/positive cases", () => {
    it("catches console.log of a bare prUrl", () => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "tlint-"),
      );
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(
        path.join(dir, "bin", "a.ts"),
        "const prUrl = x;\nconsole.log(prUrl);\n",
      );
      const violations = findBareTargets(dir);
      expect(violations.length).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("returns [] for a file with a target identifier but no stdout emission", () => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "tlint-"),
      );
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(
        path.join(dir, "bin", "b.ts"),
        "const worktreeDir = x;\nfs.existsSync(worktreeDir);\n",
      );
      const violations = findBareTargets(dir);
      expect(violations).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("returns [] for a stdout emission with no tracked target identifier", () => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "tlint-"),
      );
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(path.join(dir, "bin", "c.ts"), "console.log('hi');\n");
      const violations = findBareTargets(dir);
      expect(violations).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("skips *.test.ts files", () => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "tlint-"),
      );
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(
        path.join(dir, "bin", "d.test.ts"),
        "const prUrl = x;\nconsole.log(prUrl);\n",
      );
      const violations = findBareTargets(dir);
      expect(violations).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("skips bin/fixtures/", () => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "tlint-"),
      );
      fs.mkdirSync(path.join(dir, "bin", "fixtures"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "bin", "fixtures", "e.ts"),
        "const prUrl = x;\nconsole.log(prUrl);\n",
      );
      const violations = findBareTargets(dir);
      expect(violations).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("catches pr.url printed via process.stdout.write", () => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "tlint-"),
      );
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(
        path.join(dir, "bin", "f.ts"),
        "process.stdout.write(pr.url + '\\n');\n",
      );
      const violations = findBareTargets(dir);
      expect(violations.length).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
