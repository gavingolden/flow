#!/usr/bin/env bun
/**
 * Live macOS probe: is a fresh worktree in `flow-worktrees.noindex/` skipped by
 * Spotlight while a control folder beside the main checkout is indexed?
 *
 * Usage: bun scripts/probe-worktree-noindex.ts [--repo <main checkout>] [--timeout-sec <n=120>]
 *
 * Exit codes: 0 - control indexed (>0) and worktree 0; 1 - the worktree was
 * indexed (count printed); 2 - the control was never indexed within the
 * timeout (inconclusive); 3 - not macOS.
 *
 * Counts use `kMDItemContentTypeTree == "public.item"`: the
 * `kMDItemFSName == "*"` query returns 0 even for indexed folders.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { worktreeContainerDir, worktreeDirFor } from "../bin/lib/worktree-slot";

const QUERY = 'kMDItemContentTypeTree == "public.item"';
const GRACE_MS = 20_000;
const POLL_MS = 2_000;

function sh(cmd: string, args: string[], cwd?: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" });
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function indexedCount(dir: string): number {
  const r = sh("mdfind", ["-count", "-onlyin", dir, QUERY]);
  const n = Number.parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function defaultRepo(): string {
  const r = sh("git", ["worktree", "list", "--porcelain"]);
  const first = (r.stdout ?? "").split("\n")[0] ?? "";
  if (r.status !== 0 || !first.startsWith("worktree ")) {
    console.error("not inside a git repo; pass --repo <main checkout>");
    process.exit(2);
  }
  return first.slice("worktree ".length).trim();
}

async function main(): Promise<number> {
  if (process.platform !== "darwin") {
    console.log("not macOS - Spotlight is not in play; nothing to probe");
    return 3;
  }
  const repo = path.resolve(argValue("--repo") ?? defaultRepo());
  const timeoutMs = Number(argValue("--timeout-sec") ?? 120) * 1000;
  const ts = Date.now();
  const worktree = worktreeDirFor(repo, `noindex-probe-${ts}`);
  const control = path.join(path.dirname(repo), `noindex-probe-control-${ts}`);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    sh("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    fs.rmSync(control, { recursive: true, force: true });
    console.log("cleanup: removed the probe worktree and control folder");
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    fs.mkdirSync(worktreeContainerDir(repo), { recursive: true });
    const add = sh("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "--detach",
      worktree,
      "HEAD",
    ]);
    if (add.status !== 0) {
      console.error(`git worktree add failed: ${add.stderr}`);
      return 2;
    }
    fs.writeFileSync(
      path.join(worktree, `noindex-probe-${ts}-wt.txt`),
      "probe",
    );
    fs.mkdirSync(control, { recursive: true });
    fs.writeFileSync(
      path.join(control, `noindex-probe-${ts}-ctl.txt`),
      "probe",
    );
    console.log(`phase 1: created worktree ${worktree} and control ${control}`);

    const deadline = Date.now() + timeoutMs;
    let controlCount = 0;
    while (Date.now() < deadline) {
      controlCount = indexedCount(control);
      if (controlCount > 0) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (controlCount === 0) {
      console.log(
        `phase 2: control never indexed within ${timeoutMs / 1000}s - inconclusive`,
      );
      return 2;
    }
    console.log(`phase 2: control indexed (${controlCount} items)`);

    console.log(
      `phase 3: waiting ${GRACE_MS / 1000}s grace before counting the worktree`,
    );
    await new Promise((r) => setTimeout(r, GRACE_MS));
    const wtCount = indexedCount(worktree);
    if (wtCount > 0) {
      console.log(`FAIL: Spotlight indexed ${wtCount} items in ${worktree}`);
      return 1;
    }
    console.log("PASS: control indexed, worktree has 0 indexed items");
    return 0;
  } finally {
    cleanup();
  }
}

process.exit(await main());
