#!/usr/bin/env bun
/**
 * Triage-time repo-fit probe: checks whether the surfaces and domain nouns a
 * request names exist in the target repo. The supervisor derives the terms;
 * this helper only probes and decides.
 *
 * Usage:
 *   flow-repo-fit --repo <dir> --term <t> [--term <t>...] [--json]
 *
 * Output (stdout): JSON {verdict, repoName, hits, probes}. Exit 0 for every
 * verdict; exit 2 on usage errors.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type Verdict = "fit" | "unclear" | "wrong-repo";
export type TermHit = {
  term: string;
  kind: "path" | "noun";
  paths: string[];
};

const EXCLUDES = ["node_modules", ".git", "dist", ".flow-tmp"];
const MAX_PATHS = 5;

export function decideRepoFit(hits: TermHit[], nameMatches: number): Verdict {
  const pathHit = hits.some((h) => h.kind === "path" && h.paths.length > 0);
  const nounHits = hits.filter(
    (h) => h.kind === "noun" && h.paths.length > 0,
  ).length;
  if (pathHit || nounHits >= 2) return "fit";
  if (nounHits === 0 && nameMatches === 0) return "wrong-repo";
  return "unclear";
}

function looksLikePath(term: string): boolean {
  return /[/\\]/.test(term) || /\.[A-Za-z0-9]{1,5}$/.test(term);
}

function grepTerm(repo: string, term: string): string[] {
  const args = ["-rliF", ...EXCLUDES.map((d) => `--exclude-dir=${d}`)];
  const r = spawnSync("grep", [...args, "--", term, "."], {
    cwd: repo,
    encoding: "utf8",
  });
  return (r.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ""))
    .slice(0, MAX_PATHS);
}

function readFirstLine(file: string): string {
  try {
    return readFileSync(file, "utf8").split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

function readPackageName(repo: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    return typeof pkg.name === "string" ? pkg.name : "";
  } catch {
    return "";
  }
}

export function run(argv: string[]): number {
  let repo = "";
  const terms: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--term") terms.push(argv[++i] ?? "");
    else if (a === "--json") continue;
    else {
      console.error(`flow-repo-fit: unknown argument: ${a}`);
      return 2;
    }
  }
  if (!repo || terms.length === 0 || terms.some((t) => !t.trim())) {
    console.error(
      "usage: flow-repo-fit --repo <dir> --term <t> [--term <t>...] [--json]",
    );
    return 2;
  }
  const root = resolve(repo);
  if (!existsSync(root)) {
    console.error(`flow-repo-fit: repo not found: ${root}`);
    return 2;
  }

  const readmeTitle = readFirstLine(join(root, "README.md"));
  const pkgName = readPackageName(root);
  const repoName = pkgName || basename(root);
  const probes: string[] = [];
  const hits: TermHit[] = [];
  let nameMatches = 0;

  for (const term of terms) {
    const lower = term.toLowerCase();
    if (looksLikePath(term)) {
      const found = existsSync(join(root, term));
      probes.push(`exists ${term}: ${found}`);
      hits.push({ term, kind: "path", paths: found ? [term] : [] });
    } else {
      const paths = grepTerm(root, term);
      probes.push(`grep -rliF ${term}: ${paths.length} hit(s)`);
      hits.push({ term, kind: "noun", paths });
    }
    const inTitle = readmeTitle.toLowerCase().includes(lower);
    const inName = pkgName.toLowerCase().includes(lower);
    probes.push(`readme-title ${term}: ${inTitle}; package-name: ${inName}`);
    if (inTitle || inName) nameMatches++;
  }

  const verdict = decideRepoFit(hits, nameMatches);
  console.log(JSON.stringify({ verdict, repoName, hits, probes }));
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
