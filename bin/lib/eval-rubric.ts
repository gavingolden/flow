/**
 * Parse rubric.yml and run the deterministic hard-checks against a scratch repo.
 *
 * Schema:
 *   hard:
 *     must_pass:        # list of shell commands run from repo root, each must exit 0
 *       - "npm test"
 *     must_create:      # globs that must exist post-run
 *       - "bin/cli.ts"
 *     must_not_modify:  # globs the diff must not touch
 *       - "package.json"
 *   soft:               # YES/NO criteria handed to the judge separately
 *     - "..."
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as yaml from "js-yaml";

export type Rubric = {
  hard: {
    mustPass: string[];
    mustCreate: string[];
    mustNotModify: string[];
  };
  soft: string[];
};

export type HardFailure = {
  check: "must_pass" | "must_create" | "must_not_modify";
  detail: string;
  reason: string;
};

export type HardResult = {
  pass: boolean;
  failures: HardFailure[];
};

export function parseRubric(rubricPath: string): Rubric {
  const raw = fs.readFileSync(rubricPath, "utf8");
  const doc = yaml.load(raw);
  if (!isObject(doc)) throw new Error(`rubric ${rubricPath}: expected an object at the top level`);

  const hard = isObject(doc.hard) ? doc.hard : {};
  const rubric: Rubric = {
    hard: {
      mustPass: stringList(hard.must_pass),
      mustCreate: stringList(hard.must_create),
      mustNotModify: stringList(hard.must_not_modify),
    },
    soft: stringList(doc.soft),
  };

  const totalChecks =
    rubric.hard.mustPass.length +
    rubric.hard.mustCreate.length +
    rubric.hard.mustNotModify.length +
    rubric.soft.length;
  if (totalChecks === 0) {
    throw new Error(`rubric ${rubricPath}: at least one check (hard or soft) is required`);
  }

  return rubric;
}

/**
 * Run hard checks against a repo. Caller passes the unified diff text (e.g. from
 * `git diff baseline-commit..HEAD`) so we can validate must_not_modify without
 * spawning git ourselves.
 */
export function runHardChecks(
  rubric: Rubric,
  repoDir: string,
  changedPaths: string[],
): HardResult {
  const failures: HardFailure[] = [];

  for (const cmd of rubric.hard.mustPass) {
    const result = spawnSync("sh", ["-c", cmd], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const tail = ((result.stderr ?? "") + (result.stdout ?? "")).trim().split("\n").slice(-5).join("\n");
      failures.push({
        check: "must_pass",
        detail: cmd,
        reason: `exit ${result.status}: ${tail || "(no output)"}`,
      });
    }
  }

  for (const glob of rubric.hard.mustCreate) {
    if (!anyPathExists(repoDir, glob)) {
      failures.push({
        check: "must_create",
        detail: glob,
        reason: `no file matched glob ${glob} under ${repoDir}`,
      });
    }
  }

  const matcher = compileGlobs(rubric.hard.mustNotModify);
  for (const p of changedPaths) {
    if (matcher(p)) {
      failures.push({
        check: "must_not_modify",
        detail: p,
        reason: `${p} was modified but is in must_not_modify`,
      });
    }
  }

  return { pass: failures.length === 0, failures };
}

function compileGlobs(globs: string[]): (p: string) => boolean {
  const regexes = globs.map(globToRegex);
  return (p) => regexes.some((rx) => rx.test(p));
}

function globToRegex(glob: string): RegExp {
  let rx = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        rx += ".*";
        i += 2;
        if (glob[i] === "/") i++;
        continue;
      }
      rx += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      rx += "[^/]";
      i++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(c)) rx += "\\";
    rx += c;
    i++;
  }
  rx += "$";
  return new RegExp(rx);
}

function anyPathExists(repoDir: string, glob: string): boolean {
  if (!glob.includes("*") && !glob.includes("?")) {
    return fs.existsSync(path.join(repoDir, glob));
  }
  const files = walk(repoDir, repoDir);
  const matcher = compileGlobs([glob]);
  return files.some((f) => matcher(f));
}

function walk(root: string, dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, abs, out);
    else out.push(path.relative(root, abs));
  }
  return out;
}

function stringList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`expected an array, got ${typeof v}`);
  return v.map((x) => {
    if (typeof x !== "string") throw new Error(`expected string list entry, got ${typeof x}`);
    return x;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
