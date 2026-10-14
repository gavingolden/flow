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
 *    `.env`/shell env" instruction, and the obsolete "token was already
 *    spent" wording.
 *
 * Two more blocks pin the login hand-off (every doc naming `flow-ui-login
 * serve` carries `<!-- flow-ui-login-handoff -->` and none instructs saving,
 * slicing, piping or backgrounding its output) and the after-denial teardown
 * exception (`<!-- flow-denial-teardown -->`, plus the verify carve-out's
 * `flow-browser-teardown --reap --record` before the escalation).
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
    expect(`the ${OLD_TOKEN_PHRASE}, the origin`.includes(OLD_TOKEN_PHRASE)).toBe(
      true,
    );
  });
});

const HANDOFF_ANCHOR = "<!-- flow-ui-login-handoff -->";
const DENIAL_TEARDOWN_ANCHOR = "<!-- flow-denial-teardown -->";

// Shapes of the incident's own commands: saving serve's output to a file,
// jq-ing fillScript out of it, slicing it with head/tail, backgrounding
// serve. Each of those made the model re-read or hand-assemble the script,
// which the classifier read as tunnelling the credential fetch.
const FORBIDDEN_HANDOFF_PATTERNS: RegExp[] = [
  /jq[^\n]*fillScript/,
  /fillScript[^\n]*\|\s*(head|tail|cut|sed|awk)/,
  /flow-ui-login serve[^\n`]*(\s&\s|\s&$|\s>\s?|\|)/m,
  /nohup\s+flow-ui-login/,
];

const SERVE_MENTION = /flow-ui-login\s+serve/;

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

const SERVE_DOCS = [
  ...markdownFiles("skills"),
  ...markdownFiles("templates/rules"),
].filter((rel) => SERVE_MENTION.test(read(rel)));

describe("credential-denial lint — login hand-off", () => {
  it("finds the docs that mention flow-ui-login serve", () => {
    expect(SERVE_DOCS).toEqual(
      expect.arrayContaining([
        "skills/pipeline/flow-pipeline/references/ui-smoke-pass.md",
        "skills/pipeline/flow-pr-review/references/ui-validation-evidence.md",
        "skills/pipeline/flow-ui-driver-instructions/SKILL.md",
        "templates/rules/ui-validation.md",
      ]),
    );
  });

  it.each(SERVE_DOCS)("%s carries the hand-off anchor", (relPath) => {
    expect(read(relPath), `${relPath} missing hand-off anchor`).toContain(
      HANDOFF_ANCHOR,
    );
  });

  it.each(SERVE_DOCS)(
    "%s never instructs saving, slicing, piping or backgrounding serve",
    (relPath) => {
      const text = read(relPath);
      for (const pattern of FORBIDDEN_HANDOFF_PATTERNS) {
        expect(text, `${relPath} matches ${pattern}`).not.toMatch(pattern);
      }
    },
  );

  it("[negative] the anchor predicate catches a line-wrapped serve mention without the anchor", () => {
    const text = "log in through `flow-ui-login\n  serve` and run the script";
    expect(SERVE_MENTION.test(text)).toBe(true);
    expect(text.includes(HANDOFF_ANCHOR)).toBe(false);
  });

  it.each([
    "cd /w && jq -r .fillScript .flow-tmp/ui-login-serve.out | tail -n +28",
    "flow-ui-login serve --manifest m --worktree w > .flow-tmp/ui-login-serve.out 2>&1 &",
    "nohup flow-ui-login serve --manifest m --worktree w",
  ])("[negative] the forbidden patterns catch the incident command: %s", (cmd) => {
    expect(FORBIDDEN_HANDOFF_PATTERNS.some((p) => p.test(cmd))).toBe(true);
  });

  it("[negative] a clean standalone serve call is not flagged", () => {
    const clean =
      "`flow-ui-login serve --manifest /w/.flow/ui-validation.json --origin http://localhost:5173 --worktree /w`";
    expect(FORBIDDEN_HANDOFF_PATTERNS.some((p) => p.test(clean))).toBe(false);
  });
});

describe("credential-denial lint — after-denial teardown", () => {
  const TEARDOWN_SITES = [
    "skills/pipeline/flow-ui-driver-instructions/SKILL.md",
    "skills/pipeline/flow-pipeline/references/ui-smoke-pass.md",
    "skills/pipeline/flow-pr-review/references/ui-validation-evidence.md",
  ];

  it.each(TEARDOWN_SITES)("%s carries the denial-teardown anchor", (relPath) => {
    expect(read(relPath), `${relPath} missing teardown anchor`).toContain(
      DENIAL_TEARDOWN_ANCHOR,
    );
  });

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
