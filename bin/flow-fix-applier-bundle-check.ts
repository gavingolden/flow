#!/usr/bin/env bun
/**
 * Deterministic bundle check for `/flow-pr-review` Step 8: lists the fix-applier
 * artifact's unfixed `anti_patterns_found` entries that sit inside this PR's
 * scope (introduced here, blocked this PR's own fix, or beside its changes)
 * and so deserve one more fix attempt under the fix-now bar.
 *
 * Usage:
 *   flow-fix-applier-bundle-check --artifact <path> --worktree <dir> --base <ref> [--prior <bundle-check.json>] [--out <path>]
 *
 * Prints one JSON line (a `BundleCheck`) on stdout (and to --out when given),
 * exit 0. Exit 2 on bad args, a git failure, or an unreadable/unparseable input.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { WHY_NOT_FIXED_PREFIXES } from "./lib/negative-findings-schema";

export type GapAdjacency = "introduced" | "blocked" | "touched" | "referenced";
export type GapJustification =
  | "missing"
  | "out-of-scope"
  | "not-small"
  | "not-mechanical"
  | "not-confident";
export type BundleCandidate = {
  index: number;
  location: string;
  pattern: string;
  adjacency: GapAdjacency;
  justification: GapJustification;
  blockedFindingId: string | null;
};
export type BundleCheck = {
  needsContinuation: boolean;
  candidates: BundleCandidate[];
  touchedFiles: number;
};
type Ctx = {
  touchedFiles: string[];
  readFile: (repoRelPath: string) => string | null;
  priorBlocked?: BundleCandidate[];
};
type Rec = Record<string, unknown>;

const USAGE =
  "usage: flow-fix-applier-bundle-check --artifact <path> --worktree <dir> --base <ref> [--prior <path>] [--out <path>]";
const MAX_BYTES = 1024 * 1024;
const JUSTIFICATION_BY_PREFIX: Record<string, GapJustification> = {
  "not small: ": "not-small",
  "not mechanical: ": "not-mechanical",
  "out of scope: ": "out-of-scope",
  "not confident: ": "not-confident",
};

const recs = (v: unknown): Rec[] =>
  Array.isArray(v)
    ? v.filter(
        (x): x is Rec =>
          typeof x === "object" && x !== null && !Array.isArray(x),
      )
    : [];
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const stripLine = (loc: string): string => loc.replace(/:\d+(:\d+)?$/, "");

function findingFile(id: string): string | null {
  const i = id.indexOf(":");
  if (i < 0) return null;
  const m = id.slice(i + 1).match(/^(.+?):\d+:[^:]+(?::\d+)?$/);
  return m ? m[1] : null;
}

function justificationOf(why: unknown): GapJustification {
  const w = str(why).trimStart();
  for (const p of WHY_NOT_FIXED_PREFIXES) {
    if (w.startsWith(p)) return JUSTIFICATION_BY_PREFIX[p];
  }
  return "missing";
}

function stemOf(p: string): string {
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  return base === "index" ? path.basename(path.dirname(p)) : base;
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function imports(content: string | null, otherPath: string): boolean {
  if (content === null || content.length > MAX_BYTES) return false;
  const stem = escapeRe(stemOf(otherPath));
  return new RegExp(
    `(from|import\\s*\\(?|require\\s*\\()\\s*['"][^'"]*/${stem}(\\.[a-z0-9]+)?['"]`,
  ).test(content);
}

function oneHop(a: string, b: string, ctx: Ctx): boolean {
  if (a === b) return true;
  return imports(ctx.readFile(a), b) || imports(ctx.readFile(b), a);
}

export function classifyUnfixedAntiPatterns(
  artifact: {
    commits?: unknown[];
    rejected_alternatives?: unknown[];
    anti_patterns_found?: unknown[];
  },
  ctx: Ctx,
): BundleCandidate[] {
  const commits = recs(artifact.commits);
  const filesOfFinding = (id: string): string[] =>
    commits
      .filter((c) => c.finding_id === id)
      .flatMap((c) => (Array.isArray(c.files) ? c.files.map(str) : []));
  const blockers = recs(artifact.rejected_alternatives).flatMap((r) => {
    const id = str(r.finding_id);
    if (!id) return [];
    const f = findingFile(id);
    return [{ id, files: [...(f ? [f] : []), ...filesOfFinding(id)] }];
  });
  const touched = new Set(ctx.touchedFiles);
  const out: BundleCandidate[] = [];
  const entries = recs(artifact.anti_patterns_found);

  entries.forEach((e, index) => {
    const location = str(e.location);
    const gap = stripLine(location);
    const explicit = str(e.blocked_finding_id);
    const inferred = blockers.find((b) =>
      b.files.some((f) => oneHop(f, gap, ctx)),
    );
    let adjacency: GapAdjacency | null = null;
    let blockedFindingId: string | null = null;
    if (e.introduced_by_this_pr === true) adjacency = "introduced";
    else if (explicit) {
      adjacency = "blocked";
      blockedFindingId = explicit;
    } else if (inferred) {
      adjacency = "blocked";
      blockedFindingId = inferred.id;
    } else if (touched.has(gap)) adjacency = "touched";
    else if (ctx.touchedFiles.some((t) => oneHop(t, gap, ctx)))
      adjacency = "referenced";
    if (!adjacency) return;
    if (adjacency === "introduced" && explicit) blockedFindingId = explicit;
    const justification = justificationOf(e.why_not_fixed);
    const forced = adjacency === "introduced" || adjacency === "blocked";
    if (
      forced ||
      justification === "missing" ||
      justification === "out-of-scope"
    ) {
      out.push({
        index,
        location,
        pattern: str(e.pattern),
        adjacency,
        justification,
        blockedFindingId,
      });
    }
  });

  for (const prior of ctx.priorBlocked ?? []) {
    if (prior.adjacency !== "blocked") continue;
    const stillThere = entries.some(
      (e) =>
        str(e.location) === prior.location && str(e.pattern) === prior.pattern,
    );
    if (stillThere) continue;
    const own = new Set(filesOfFinding(prior.blockedFindingId ?? ""));
    const restrengthened = filesOfFinding(`bundle:${prior.location}`).some(
      (f) => own.has(f),
    );
    if (!restrengthened) out.push(prior);
  }
  return out;
}

type Args = {
  artifact?: string;
  worktree?: string;
  base?: string;
  prior?: string;
  out?: string;
};

function parseArgs(argv: string[]): Args | string {
  const args: Args = {};
  const flags: Record<string, keyof Args> = {
    "--artifact": "artifact",
    "--worktree": "worktree",
    "--base": "base",
    "--prior": "prior",
    "--out": "out",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key) return `unknown argument '${argv[i]}'`;
    if (argv[i + 1] === undefined) return `${argv[i]} needs a value`;
    args[key] = argv[++i];
  }
  for (const req of ["artifact", "worktree", "base"] as const) {
    if (!args[req]) return `--${req} is required`;
  }
  return args;
}

function readJson(p: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(
      `${label} ${p} is unreadable or not valid JSON: ${(e as Error).message}`,
    );
  }
}

export function run(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => console.log(s),
    stderr: (s) => console.error(s),
  },
): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.stderr(`flow-fix-applier-bundle-check: ${args}\n${USAGE}`);
    return 2;
  }
  try {
    const worktree = path.resolve(args.worktree as string);
    const artifact = readJson(args.artifact as string, "artifact");
    if (typeof artifact !== "object" || artifact === null) {
      throw new Error("artifact must be a JSON object");
    }
    const prior = args.prior ? readJson(args.prior, "prior") : null;
    const touchedFiles = execFileSync(
      "git",
      ["-C", worktree, "diff", "--name-only", `${args.base}...HEAD`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\n")
      .filter(Boolean);
    const readFile = (rel: string): string | null => {
      const abs = path.resolve(worktree, rel);
      if (!abs.startsWith(worktree + path.sep)) return null;
      try {
        if (fs.statSync(abs).size > MAX_BYTES) return null;
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    };
    const candidates = classifyUnfixedAntiPatterns(artifact as Rec, {
      touchedFiles,
      readFile,
      priorBlocked: recs(
        (prior as Rec | null)?.candidates,
      ) as BundleCandidate[],
    });
    const check: BundleCheck = {
      needsContinuation: candidates.length > 0,
      candidates,
      touchedFiles: touchedFiles.length,
    };
    const line = JSON.stringify(check);
    if (args.out) fs.writeFileSync(args.out, `${line}\n`);
    io.stdout(line);
    return 0;
  } catch (e) {
    io.stderr(`flow-fix-applier-bundle-check: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
