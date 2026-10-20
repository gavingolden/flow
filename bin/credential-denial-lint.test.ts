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
 * All checks are `fs.readFileSync`-based (never the shell `grep`, which
 * silently treats `ui-smoke-pass.md`'s very long lines as binary and skips
 * them — see that file's own header note):
 *
 * 1. The rule anchor `<!-- flow-credential-denial-rule -->` plus the terms
 *    `credentials-unavailable` and `flow-ui-login test-account` are all
 *    present in each of the four rule sites.
 * 2. Across those four files plus the two sibling docs the login recipe was
 *    rewritten in, none of the three pre-fix phrases survives anywhere: the
 *    `fill`-with-values instruction, the "resolve from the local
 *    `.env`/shell env" instruction, and the obsolete "token was already
 *    spent" wording.
 * 3. Dead references: no `.md` under skills/, templates/, references/ or
 *    docs/ names the retired loopback hand-off (`flow-ui-login serve`,
 *    `fillScript`, `fetch-blocked`, `endpoint-refused`,
 *    `flow-ui-login-handoff`, `__serve-child`, the "one-time endpoint"), and
 *    none tells the agent to pipe, redirect, background or `nohup`
 *    `flow-ui-login test-account` (its output carries the password).
 * 4. The after-denial teardown exception (`<!-- flow-denial-teardown -->`,
 *    plus the verify carve-out's `flow-browser-teardown --reap --record`
 *    before the escalation).
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
const OLD_TOKEN_PHRASE = "token was already spent";

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function standaloneAnchorCount(text: string, anchor: string): number {
  return text.split("\n").filter((line) => line.trim() === anchor).length;
}

function markdownFiles(relDir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, relDir), {
    withFileTypes: true,
  })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
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
      expect(text, `${relPath} missing flow-ui-login test-account`).toContain(
        "flow-ui-login test-account",
      );
    },
  );

  it.each(RULE_SITES)("%s carries the rule anchor exactly once", (relPath) => {
    expect(
      standaloneAnchorCount(read(relPath), RULE_ANCHOR),
      `${relPath} must carry exactly one standalone rule anchor`,
    ).toBe(1);
  });

  it("[negative] a file without the anchor would fail", () => {
    const text = "some unrelated skill prose with no rule block";
    expect(text.includes(RULE_ANCHOR)).toBe(false);
  });

  it("[negative] a duplicated standalone anchor is counted, an inline mention is not", () => {
    const dup = `${RULE_ANCHOR}\n\nprose\n\n${RULE_ANCHOR}\n`;
    const inline = `${RULE_ANCHOR}\n\nsee the \`${RULE_ANCHOR}\` above`;
    expect(standaloneAnchorCount(dup, RULE_ANCHOR)).toBe(2);
    expect(standaloneAnchorCount(inline, RULE_ANCHOR)).toBe(1);
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

  it.each(NO_OLD_PHRASE_FILES)(
    "%s no longer describes a spent bearer token",
    (relPath) => {
      const text = read(relPath);
      expect(
        text,
        `${relPath} still contains the bearer-token phrase`,
      ).not.toContain(OLD_TOKEN_PHRASE);
    },
  );

  it("[negative] the old phrase would be caught if reintroduced", () => {
    const text = `fill the located fields with the resolved user/pass VALUES`;
    expect(text.includes(OLD_FILL_PHRASE)).toBe(true);
    expect(
      `the ${OLD_TOKEN_PHRASE}, the origin`.includes(OLD_TOKEN_PHRASE),
    ).toBe(true);
  });
});

const DENIAL_TEARDOWN_ANCHOR = "<!-- flow-denial-teardown -->";

const DOC_FILES = ["skills", "templates", "references", "docs"].flatMap(
  markdownFiles,
);

// Whitespace-tolerant so a line-wrapped `flow-ui-login\n  serve` is caught.
const DEAD_REFERENCES: RegExp[] = [
  /flow-ui-login\s+serve/,
  /fillScript/,
  /fetch-blocked/,
  /endpoint-refused/,
  /flow-ui-login-handoff/,
  /__serve-child/,
  /one-time\s+endpoint/,
];

// `test-account` prints the plaintext password: a doc that tells the agent to
// save, pipe, background or nohup it would put the value on disk or into
// another tool result.
const FORBIDDEN_TEST_ACCOUNT_PATTERNS: RegExp[] = [
  /flow-ui-login\s+test-account[^\n`]*(\s&\s|\s&$|\s>\s?|\|)/m,
  /nohup\s+flow-ui-login/,
];

describe("credential-denial lint — dead references", () => {
  it("scans the doc trees", () => {
    expect(DOC_FILES).toEqual(
      expect.arrayContaining([
        "skills/pipeline/flow-ui-driver-instructions/SKILL.md",
        "templates/rules/ui-validation.md",
        "references/consumer-repo-contract.md",
        "docs/configuration.md",
      ]),
    );
  });

  it.each(DOC_FILES)(
    "%s names none of the retired loopback login path",
    (relPath) => {
      const text = read(relPath);
      for (const dead of DEAD_REFERENCES) {
        expect(text, `${relPath} still matches ${dead}`).not.toMatch(dead);
      }
    },
  );

  it("[negative] a doc still naming the retired path would be caught", () => {
    for (const text of [
      "log in through `flow-ui-login serve` and run the fillScript",
      "log in through `flow-ui-login\n  serve` here",
      "never curl the helper's one-time endpoint",
      "never curl the helper's one-time\nendpoint",
    ]) {
      expect(DEAD_REFERENCES.some((dead) => dead.test(text))).toBe(true);
    }
  });
});

describe("credential-denial lint — test-account output handling", () => {
  it.each(DOC_FILES)(
    "%s never instructs piping, redirecting or backgrounding test-account",
    (relPath) => {
      const text = read(relPath);
      for (const pattern of FORBIDDEN_TEST_ACCOUNT_PATTERNS) {
        expect(text, `${relPath} matches ${pattern}`).not.toMatch(pattern);
      }
    },
  );

  it.each<[number, string]>([
    [0, "flow-ui-login test-account --manifest m > out.txt"],
    [0, "flow-ui-login test-account --manifest m --worktree w 2>&1 &"],
    [0, "flow-ui-login test-account --manifest m --worktree w &"],
    [0, "flow-ui-login test-account --manifest m | jq -r .pass"],
    [0, "flow-ui-login   test-account --manifest m > out.txt"],
    [0, "flow-ui-login\n  test-account --manifest m | tee out.txt"],
    [1, "nohup flow-ui-login test-account --manifest m --worktree w"],
  ])("[negative] forbidden pattern %i catches: %s", (index, cmd) => {
    expect(FORBIDDEN_TEST_ACCOUNT_PATTERNS[index].test(cmd)).toBe(true);
  });

  it("[negative] a clean standalone test-account call is not flagged", () => {
    const clean =
      "`flow-ui-login test-account --manifest /w/.flow/ui-validation.json --worktree /w`";
    expect(FORBIDDEN_TEST_ACCOUNT_PATTERNS.some((p) => p.test(clean))).toBe(
      false,
    );
  });
});

describe("credential-denial lint — after-denial teardown", () => {
  const TEARDOWN_SITES = [
    "skills/pipeline/flow-ui-driver-instructions/SKILL.md",
    "skills/pipeline/flow-pipeline/references/ui-smoke-pass.md",
    "skills/pipeline/flow-pr-review/references/ui-validation-evidence.md",
    "skills/pipeline/flow-fix-applier-instructions/SKILL.md",
  ];

  it.each(TEARDOWN_SITES)(
    "%s carries the denial-teardown anchor",
    (relPath) => {
      expect(read(relPath), `${relPath} missing teardown anchor`).toContain(
        DENIAL_TEARDOWN_ANCHOR,
      );
    },
  );

  it.each(TEARDOWN_SITES)(
    "%s names the pipeline's reap, not the caller's",
    (relPath) => {
      const text = read(relPath);
      expect(text, `${relPath} should name the pipeline's reap`).toMatch(
        /pipeline's\s+`flow-browser-teardown --reap --record`/,
      );
      expect(text, `${relPath} still says the caller's reap`).not.toMatch(
        /caller's\s+`flow-browser-teardown/,
      );
    },
  );

  it("flow-verify's carve-out reaps with flow-browser-teardown before escalating smoketest-needs-creds", () => {
    const text = read("skills/pipeline/flow-verify/SKILL.md");
    const carveOut = text.slice(text.indexOf("**Named carve-out:**"));
    const reap = carveOut.indexOf("flow-browser-teardown --reap --record");
    const escalate = carveOut.indexOf("NEEDS HUMAN: smoketest-needs-creds");
    expect(reap).toBeGreaterThan(-1);
    expect(escalate).toBeGreaterThan(-1);
    expect(reap).toBeLessThan(escalate);
  });

  it("[negative] a carve-out that escalates without reaping fails the order check", () => {
    const carveOut = "escalate `NEEDS HUMAN: smoketest-needs-creds` only";
    expect(carveOut.indexOf("flow-browser-teardown --reap --record")).toBe(-1);
  });
});
