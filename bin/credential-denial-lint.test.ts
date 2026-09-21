import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pins the shared credential-denial stop rule the 2026-09-20 secret-leak
 * incident's fix introduced: a permission/deny/classifier refusal of any
 * credential-related action must stop the browser check, never route
 * through another tool.
 *
 * Two checks, both `fs.readFileSync`-based (never the shell `grep`, which
 * silently treats `ui-smoke-pass.md`'s very long lines as binary and skips
 * them — see that file's own header note):
 *
 * 1. The rule anchor `<!-- flow-credential-denial-rule -->` plus the terms
 *    `credentials-unavailable`, `fetch-blocked` and `flow-ui-login` are all
 *    present in each of the four rule sites.
 * 2. Across those four files plus the two sibling docs the login recipe was
 *    rewritten in, neither of the two pre-fix phrases survives anywhere:
 *    the `fill`-with-values instruction, and the "resolve from the local
 *    `.env`/shell env" instruction.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const RULE_SITES = [
  "skills/pipeline/flow-ui-driver-instructions/SKILL.md",
  "skills/pipeline/flow-fix-applier-instructions/SKILL.md",
  "skills/pipeline/flow-verify/SKILL.md",
  "skills/pipeline/flow-pr-review/references/ui-validation-evidence.md",
];

const NO_OLD_PHRASE_FILES = [
  ...RULE_SITES,
  "skills/pipeline/flow-pipeline/references/ui-smoke-pass.md",
  "templates/rules/ui-validation.md",
];

const RULE_ANCHOR = "<!-- flow-credential-denial-rule -->";

const OLD_FILL_PHRASE = "the located fields with the resolved user/pass VALUES";
const OLD_ENV_PHRASE = "from the local `.env`/shell env";

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("credential-denial lint — rule sites", () => {
  it.each(RULE_SITES)(
    "%s carries the full rule anchor + vocabulary",
    (relPath) => {
      const text = read(relPath);
      expect(text, `${relPath} missing rule anchor`).toContain(RULE_ANCHOR);
      expect(text, `${relPath} missing credentials-unavailable`).toContain(
        "credentials-unavailable",
      );
      expect(text, `${relPath} missing fetch-blocked`).toContain(
        "fetch-blocked",
      );
      expect(text, `${relPath} missing flow-ui-login`).toContain(
        "flow-ui-login",
      );
    },
  );

  it("[negative] a file without the anchor would fail", () => {
    const text = "some unrelated skill prose with no rule block";
    expect(text.includes(RULE_ANCHOR)).toBe(false);
  });
});

describe("credential-denial lint — old phrases removed", () => {
  it.each(NO_OLD_PHRASE_FILES)(
    "%s no longer instructs a fill-with-values login",
    (relPath) => {
      const text = read(relPath);
      expect(
        text,
        `${relPath} still contains the fill-with-values phrase`,
      ).not.toContain(OLD_FILL_PHRASE);
    },
  );

  it.each(NO_OLD_PHRASE_FILES)(
    "%s no longer tells the agent to resolve from local env",
    (relPath) => {
      const text = read(relPath);
      expect(
        text,
        `${relPath} still contains the local-env phrase`,
      ).not.toContain(OLD_ENV_PHRASE);
    },
  );

  it("[negative] the old phrase would be caught if reintroduced", () => {
    const text = `fill the located fields with the resolved user/pass VALUES`;
    expect(text.includes(OLD_FILL_PHRASE)).toBe(true);
  });
});
