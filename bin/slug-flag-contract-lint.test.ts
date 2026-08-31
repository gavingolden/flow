import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs as parseGateDecide } from "./flow-gate-decide";
import { parseArgs as parseNotify } from "./flow-notify";
import { parseArgs as parseOpenPr } from "./flow-open-pr";
import { parseArgs as parseRemoveWorktree } from "./flow-remove-worktree";
import { parseArgs as parseRenameWindow } from "./flow-rename-window";
import { parseArgs as parseResumeDecide } from "./flow-resume-decide";
import { parseArgs as parseStateUpdate } from "./flow-state-update";

/**
 * Doc/code drift guard for the slug-taking-helper contract.
 *
 * `skills/pipeline/flow-pipeline/SKILL.md` tells the reader that every
 * helper named in its slug-taking-helper sentence accepts an explicit
 * `--slug <slug>` when invoked from outside the pipeline session. That
 * sentence was trusted rather than enforced, and three of the seven named
 * helpers did not honour it (gh#726) — two rejected the flag outright and
 * `flow-remove-worktree` silently discarded it and removed the caller's own
 * worktree. This lint makes the list self-enforcing: every name in the
 * sentence must parse `--slug` into the slug it names.
 *
 * Shape follows the sibling doc-drift guards `failure-docs-lint.test.ts` and
 * `gate-summary-recipe-lint.test.ts` — read the doc, extract the contract,
 * assert the code honours it.
 */

const SKILL_MD_PATH = path.resolve(
  __dirname,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);

const PROBE_SLUG = "probe-slug";

/**
 * Minimal argv per helper, each threading `--slug <PROBE_SLUG>`.
 *
 * A naive `parseArgs(["--slug", PROBE_SLUG])` probe is NOT usable here: four
 * of the seven helpers have other required arguments and would return an
 * error (`--status is required`, `at least one of --phase, --pr, ... is
 * required`, `<title> is required`, `PR number must be the first positional
 * argument`) even though they honour `--slug` perfectly. Each entry below is
 * the smallest argv that reaches a successful parse for that helper.
 *
 * Hand-maintained by necessity — which is why an extracted name with no entry
 * here is a hard failure (see the "probe map covers" test), never a silent
 * skip.
 */
const PROBES: Record<
  string,
  { argv: string[]; parse: (argv: string[]) => unknown }
> = {
  "flow-notify": {
    argv: ["--status", "merged", "--slug", PROBE_SLUG],
    parse: parseNotify,
  },
  "flow-state-update": {
    argv: ["--phase", "planning", "--slug", PROBE_SLUG],
    parse: parseStateUpdate,
  },
  "flow-rename-window": {
    argv: ["--slug", PROBE_SLUG, "some title"],
    parse: parseRenameWindow,
  },
  "flow-open-pr": {
    argv: ["--slug", PROBE_SLUG, "--body-file", "/tmp/x.md"],
    parse: parseOpenPr,
  },
  "flow-resume-decide": {
    argv: ["--slug", PROBE_SLUG],
    parse: parseResumeDecide,
  },
  "flow-gate-decide": {
    argv: ["1", "--slug", PROBE_SLUG],
    parse: parseGateDecide,
  },
  "flow-remove-worktree": {
    argv: ["--slug", PROBE_SLUG],
    parse: parseRemoveWorktree,
  },
};

/**
 * Extracts the backticked helper names from SKILL.md's slug-taking-helper
 * sentence.
 *
 * Two traps this deliberately avoids:
 *   1. The names are hard-wrapped across three source lines, so a line-scoped
 *      regex finds only the first one. Match over the whole file text, which
 *      keeps the newlines inside the parenthesised run.
 *   2. The same paragraph also backticks `FLOW_SLUG`, `@flow-slug`,
 *      `$TMUX_PANE` and `--slug`. Scope the extraction to the parenthesised
 *      list rather than the paragraph.
 */
export function extractHelperNames(skillMd: string): string[] {
  const sentence = /every slug-taking flow helper \(([^)]*)\)/.exec(skillMd);
  if (!sentence) {
    throw new Error(
      "slug-taking-helper sentence not found in SKILL.md — the lint's input " +
        "set could not be read. If the sentence was reworded, update this " +
        "regex; do not delete the helper list.",
    );
  }
  return [...sentence[1].matchAll(/`(flow-[a-z0-9-]+)`/g)].map((m) => m[1]);
}

describe("slug-flag contract lint", () => {
  const skillMd = fs.readFileSync(SKILL_MD_PATH, "utf8");
  const names = extractHelperNames(skillMd);

  it("extracts a non-empty helper list from SKILL.md", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it("extracts every backticked name in the parenthesised list", () => {
    // Guards against a reword that silently shrinks the lint's input set:
    // the extracted count must match the raw backtick count inside the parens.
    const raw = /every slug-taking flow helper \(([^)]*)\)/.exec(skillMd)![1];
    expect(names.length).toBe((raw.match(/`/g) ?? []).length / 2);
  });

  it("probe map covers every helper named in SKILL.md", () => {
    const unmapped = names.filter((n) => !(n in PROBES));
    expect(
      unmapped,
      `SKILL.md names ${unmapped.join(", ")} as accepting --slug, but this ` +
        "lint has no probe argv for them. Add an entry to PROBES — never " +
        "skip an unmapped helper, or the guard silently stops covering it.",
    ).toEqual([]);
  });

  it.each(Object.keys(PROBES))(
    "%s parses --slug into the named slug",
    (name) => {
      const parsed = PROBES[name].parse(PROBES[name].argv) as Record<
        string,
        unknown
      >;
      expect(
        parsed,
        `${name} rejected --slug: ${JSON.stringify(parsed)}`,
      ).not.toHaveProperty("error");
      expect(parsed.slug).toBe(PROBE_SLUG);
    },
  );

  // Negative direction. SKILL.md also claims the `--slug=<slug>` equals form
  // is accepted by NO flow helper. That claim needs enforcing too: an
  // unenforced universal claim is exactly the drift that produced gh#726,
  // and `flow-rename-window` really did swallow the equals form as a
  // positional until this PR — silently retargeting the ambient window.
  it.each(Object.keys(PROBES))(
    "%s rejects the --slug=<v> equals form",
    (name) => {
      // Swap the `--slug PROBE_SLUG` pair for the single equals token, leaving
      // each helper's other required args in place.
      const argv: string[] = [];
      const orig = PROBES[name].argv;
      for (let i = 0; i < orig.length; i++) {
        if (orig[i] === "--slug" && orig[i + 1] === PROBE_SLUG) {
          argv.push(`--slug=${PROBE_SLUG}`);
          i++;
          continue;
        }
        argv.push(orig[i]);
      }
      const parsed = PROBES[name].parse(argv) as Record<string, unknown>;
      expect(
        parsed,
        `${name} did not reject --slug=${PROBE_SLUG}: ${JSON.stringify(parsed)}`,
      ).toHaveProperty("error");
      // Belt and braces: even on an error path it must never have bound the
      // raw token as a value anywhere.
      expect(Object.values(parsed)).not.toContain(`--slug=${PROBE_SLUG}`);
    },
  );
});
