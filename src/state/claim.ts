import fs from "node:fs";
import path from "node:path";

// Cross-process claim primitive for `flow run <id>`. Two runners targeting
// the same triaged task race here; the loser exits cleanly with no work.
//
// Protocol — per-candidate temp + atomic exclusive link + read-back:
//
//   1. If <taskDir>/claimed-<id>.lock holds a *live* PID, lose immediately.
//   2. Otherwise (no holder, or holder is dead — stale claim), unlink
//      any stale canonical lock, write <taskDir>/claim-<id>-<pid>.tmp
//      containing our PID, then `fs.linkSync(tmp, canonical)`.
//      POSIX link(2) is atomic *and* exclusive: it fails with EEXIST
//      if the destination already exists. Whoever's link succeeds owns
//      the slot.
//   3. Read the canonical lock back as a defence-in-depth check on the
//      atomicity of step 2.
//   4. Unlink the per-candidate temp (the canonical hardlink keeps the
//      inode alive).
//
// The chat-first design doc (docs/chat-first-design.md ~388–402) spells
// this as "rename triaged-<id>.lock → claimed-<id>.lock", which presumed
// `renameat2(RENAME_NOREPLACE)` semantics — Linux-only, not portable to
// macOS. POSIX `rename(2)` overwrites unconditionally, so a literal
// "rename + read-back" protocol has a race: both candidates can see
// their own PID after rename if neither is interrupted by the other.
// `link(2)` is the portable equivalent of `RENAME_NOREPLACE` for the
// create-if-not-exists case, and the rest of the protocol (per-candidate
// temp source, dead-holder recovery via unlink-then-relink) is identical
// in spirit to the design doc.

export interface Claim {
  readonly pid: number;
  release(): void;
}

export function acquireClaim(
  taskDir: string,
  taskId: string,
  pid: number = process.pid,
): Claim | null {
  const canonical = claimedFilePath(taskDir, taskId);

  // Live-holder check is a fast-path skip: the typical concurrent-spawn
  // case is "winner already in place, loser arrives". The exclusive
  // link below is the actual race-free linearization point — this read
  // just avoids unlinking a live holder's lock by mistake.
  const existing = readPidFile(canonical);
  if (existing !== null && isProcessAlive(existing)) return null;

  // Stale claim — clear it. If two candidates concurrently observe the
  // same dead holder, both unlink (one ENOENTs harmlessly) and then
  // race on the linkSync below; exactly one wins via EEXIST.
  if (existing !== null) {
    try {
      fs.unlinkSync(canonical);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }

  const tmp = tmpClaimPath(taskDir, taskId, pid);
  try {
    fs.writeFileSync(tmp, `${pid}\n`, "utf8");
  } catch {
    return null;
  }

  // Atomic exclusive create via hardlink — fails with EEXIST if the
  // canonical path already exists. This is the linearization point.
  try {
    fs.linkSync(tmp, canonical);
  } catch {
    // Cleanup: someone else won the race, or a transient filesystem
    // error. Drop our temp regardless; we hold no claim.
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }

  // Read-back as defence in depth against filesystem weirdness. With
  // link(2)'s exclusive semantics, the recorded PID *must* be ours.
  const recorded = readPidFile(canonical);
  if (recorded !== pid) {
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }

  // The canonical path is now a hardlink to the same inode; unlink the
  // temp to keep the directory tidy.
  try { fs.unlinkSync(tmp); } catch {}

  return makeClaim(canonical, pid);
}

function makeClaim(canonical: string, ownerPid: number): Claim {
  let released = false;
  return {
    pid: ownerPid,
    release(): void {
      if (released) return;
      released = true;
      // If we've been stolen from (a stealer evicted us because they saw
      // our PID as dead — which can happen on `kill -9` paths or under
      // PID reuse), the recorded holder is no longer us. Don't unlink:
      // we'd be evicting the new owner.
      const recorded = readPidFile(canonical);
      if (recorded !== ownerPid) return;
      try {
        fs.unlinkSync(canonical);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    },
  };
}

function readPidFile(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// `process.kill(pid, 0)` is a signal-0 probe: returns void on alive,
// throws on error. ESRCH → dead; EPERM → alive but we lack permission to
// signal (don't steal — same-user policy is conservative). Other errnos
// fall back to "treat as alive" so a transient kernel oddity doesn't
// cause us to clobber a real holder.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return true;
  }
}

function claimedFilePath(taskDir: string, taskId: string): string {
  return path.join(taskDir, `claimed-${taskId}.lock`);
}

function tmpClaimPath(taskDir: string, taskId: string, pid: number): string {
  return path.join(taskDir, `claim-${taskId}-${pid}.tmp`);
}
