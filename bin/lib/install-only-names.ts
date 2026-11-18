/**
 * Names a branch adds or changes that exist only once the branch is installed
 * (PATH helpers, `flow` verbs, skills), and the matcher that tells a Test Step
 * which of them it depends on. One pure partition shared by `flow-gate-decide`
 * and `flow-merge-guard` so the gate and the merge guard cannot disagree.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDefaultBranch, type Spawner } from "./git";
import { isFlowCheckout } from "./skill-overlay-fs";
import { isPathBoundHelper } from "./sources";

export type InstallOnlyName = {
  name: string;
  kind: "helper" | "verb" | "skill";
  change: "added" | "modified";
};

export const isFlowSource = isFlowCheckout;

const defaultSpawn: Spawner = (cmd, args, options) =>
  spawnSync(cmd, args, options);

export function resolveBaseRef(repo: string, spawn?: Spawner): string {
  return "origin/" + (resolveDefaultBranch(repo, spawn) ?? "main");
}

function run(spawn: Spawner, repo: string, args: string[]): string | null {
  const r = spawn("git", args, { cwd: repo, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

function verbLiterals(src: string): string[] {
  const block = src.match(/VERBS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function skillName(repo: string, dir: string): string {
  try {
    const text = fs.readFileSync(path.join(repo, dir, "SKILL.md"), "utf8");
    const m = text.match(/^name:\s*["']?([^\s"']+)/m);
    if (m) return m[1].replace(/^[\w-]+:/, "");
  } catch {
    // fall through to the directory name
  }
  return path.basename(dir);
}

function skillDirOf(repo: string, file: string): string | null {
  for (
    let d = path.dirname(file);
    d.startsWith("skills/");
    d = path.dirname(d)
  ) {
    if (fs.existsSync(path.join(repo, d, "SKILL.md"))) return d;
  }
  return null;
}

/** [] for a non-flow-source dir; null on any git failure. Validators
 * (`bin/lib/*-schema.ts`, VALIDATOR_MODULES) are out of scope: not collected. */
export function collectInstallOnlyNames(
  repo: string,
  opts: { base?: string; spawn?: Spawner } = {},
): InstallOnlyName[] | null {
  if (!isFlowSource(repo)) return [];
  const spawn = opts.spawn ?? defaultSpawn;
  const base = opts.base ?? resolveBaseRef(repo, spawn);
  const diff = run(spawn, repo, ["diff", "--name-status", `${base}...HEAD`]);
  if (diff === null) return null;

  const out = new Map<string, InstallOnlyName>();
  const put = (n: InstallOnlyName): void => {
    const key = `${n.kind}:${n.name}`;
    if (out.get(key)?.change !== "added") out.set(key, n);
  };
  let verbsRow: string | null = null;
  for (const row of diff.split("\n")) {
    const cols = row.split("\t");
    const status = cols[0]?.[0];
    const file = cols[cols.length - 1];
    if (!status || !file || status === "D") continue;
    const change = status === "M" ? "modified" : "added";
    const m = file.match(/^bin\/([^/]+\.ts)$/);
    if (m && isPathBoundHelper(m[1])) {
      put({ name: m[1].replace(/\.ts$/, ""), kind: "helper", change });
    } else if (file === "bin/lib/verbs.ts") {
      verbsRow = status;
    } else if (file.startsWith("skills/")) {
      const dir = skillDirOf(repo, file);
      if (!dir) continue;
      const isNewSkillFile = file === `${dir}/SKILL.md` && status !== "M";
      put({
        name: skillName(repo, dir),
        kind: "skill",
        change: isNewSkillFile ? "added" : "modified",
      });
    }
  }

  if (verbsRow !== null) {
    const head = run(spawn, repo, ["show", "HEAD:bin/lib/verbs.ts"]);
    if (head === null) return null;
    const baseSrc = run(spawn, repo, ["show", `${base}:bin/lib/verbs.ts`]);
    if (baseSrc === null && verbsRow !== "A") return null;
    const before = new Set(baseSrc === null ? [] : verbLiterals(baseSrc));
    for (const verb of verbLiterals(head)) {
      if (!before.has(verb) && !verb.startsWith("-"))
        put({ name: verb, kind: "verb", change: "added" });
    }
  }
  return [...out.values()];
}

export function isGateEligible(n: InstallOnlyName): boolean {
  return (
    ((n.kind === "helper" || n.kind === "verb") && n.change === "added") ||
    n.kind === "skill"
  );
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only inline backtick spans (helpers, verbs) and bare `/<skill>` tokens count. */
export function matchInstallDependent(
  text: string,
  names: InstallOnlyName[],
): InstallOnlyName | null {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join("\n");
  const hits = names.filter((n) => {
    const e = esc(n.name);
    if (n.kind === "helper")
      return new RegExp(`(?<![\\w/.-])${e}(?![\\w.-])`).test(spans);
    if (n.kind === "verb")
      return new RegExp(`(?<![\\w/.-])flow\\s+${e}(?![\\w-])`).test(spans);
    return new RegExp(`(?<![\\w/.-])/${e}(?![\\w-])`).test(text);
  });
  return hits.find(isGateEligible) ?? hits[0] ?? null;
}

/** A needs-install step with the helper, verb or skill that matched it. */
export type InstallDependentItem = {
  item: string;
  name: string;
  kind: InstallOnlyName["kind"];
};

const AFTER_MERGE = "After merge: ";

export function partitionAfterMerge(
  unchecked: ({ text: string; kind?: string } | string)[],
  names: InstallOnlyName[] | null,
): {
  counted: string[];
  afterMerge: string[];
  unverifiedAfterMerge: string[];
  needsInstall: InstallDependentItem[];
} {
  const r = {
    counted: [] as string[],
    afterMerge: [] as string[],
    unverifiedAfterMerge: [] as string[],
    needsInstall: [] as InstallDependentItem[],
  };
  for (const item of unchecked) {
    const raw = typeof item === "string" ? item : item.text;
    const text = raw.replace(/^\s*-\s+\[ \]\s+/, "");
    const hit = names ? matchInstallDependent(text, names) : null;
    const eligible = hit !== null && isGateEligible(hit);
    if (text.startsWith(AFTER_MERGE)) {
      if (eligible) r.afterMerge.push(raw);
      else {
        r.counted.push(raw);
        r.unverifiedAfterMerge.push(raw);
      }
    } else {
      r.counted.push(raw);
      if (eligible)
        r.needsInstall.push({ item: raw, name: hit.name, kind: hit.kind });
    }
  }
  return r;
}

export function collectInstallNamesSafe(
  repo: string | undefined,
  base: string | undefined,
  spawn?: Spawner,
): InstallOnlyName[] | null {
  if (!repo || !isFlowSource(repo)) return [];
  try {
    const s = spawn ?? defaultSpawn;
    if (base) {
      s("git", ["fetch", "--quiet", "origin", base.replace(/^origin\//, "")], {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      });
    }
    return collectInstallOnlyNames(repo, { base, spawn });
  } catch (e) {
    process.stderr.write(
      `install-only-names: could not read the branch diff (${e instanceof Error ? e.message : String(e)}); After merge: steps will count as open\n`,
    );
    return null;
  }
}
