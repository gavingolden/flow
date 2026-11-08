/**
 * Process-table and working-directory readers behind the worktree sweep.
 * Every real read is guarded by `typeof Bun`, so under vitest/Node the
 * readers return "unavailable" and no unit test can become a host-wide sweep.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OrphanProc } from "./worktree-orphans";

export const ORPHAN_PS_ARGS = [
  "-ww",
  "-Ao",
  "pid=,ppid=,pgid=,uid=,tty=,etime=,time=,command=",
] as const;

/** `[dd-][hh:]mm:ss[.cc]` (etime, Linux time) and macOS `M:SS.cc` time. */
export function parseDurationSec(text: string): number | null {
  const m = /^(?:(\d+)-)?([\d:]+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const parts = m[2].split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(Number.isNaN)) {
    return null;
  }
  const [h, mi, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return Number(m[1] ?? 0) * 86400 + h * 3600 + mi * 60 + s + frac;
}

export function parsePsTable(text: string): OrphanProc[] {
  const out: OrphanProc[] = [];
  const row =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;
  for (const line of text.split("\n")) {
    const m = row.exec(line);
    const age = m ? parseDurationSec(m[6]) : null;
    const cpu = m ? parseDurationSec(m[7]) : null;
    if (m && age !== null && cpu !== null) {
      out.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        uid: Number(m[4]),
        tty: m[5] === "??" || m[5] === "?" || m[5] === "-" ? null : m[5],
        ageSec: age,
        cpuSec: cpu,
        command: m[8],
        cwd: null,
      });
    } else if (out.length > 0 && line.trim() !== "") {
      out[out.length - 1].command += `\n${line}`;
    }
  }
  return out;
}

export function listOrphanProcs(): OrphanProc[] | undefined {
  try {
    if (typeof Bun === "undefined") return undefined;
    const r = Bun.spawnSync(["ps", ...ORPHAN_PS_ARGS], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    });
    return r.exitCode === 0 ? parsePsTable(r.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) out.set(pid, line.slice(1));
  }
  return out;
}

export function stripDeletedSuffix(link: string): string {
  return link.replace(/ \(deleted\)$/, "");
}

export function readCwds(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (pids.length === 0 || typeof Bun === "undefined") return out;
  if (fs.existsSync("/proc/self")) {
    for (const pid of pids) {
      try {
        out.set(pid, stripDeletedSuffix(fs.readlinkSync(`/proc/${pid}/cwd`)));
      } catch {
        // unreadable: not selected
      }
    }
    return out;
  }
  try {
    const r = Bun.spawnSync(
      ["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"],
      { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    // A killed lsof prints a truncated list; an empty answer is the caller's "unreadable".
    if (r.exitedDueToTimeout) return out;
    // lsof exits 1 when some pids vanished yet still prints the rest.
    return parseLsofCwd(r.stdout.toString());
  } catch {
    return out;
  }
}

/** realpath, or realpath(parent) + leaf when the leaf was just removed. */
export function canonicalizeWorktree(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const abs = path.resolve(p);
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}
