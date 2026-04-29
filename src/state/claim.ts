import fs from "node:fs";
import path from "node:path";

// Cross-process claim primitive for `flow run <id>`. Two runners targeting
// the same triaged task race here; the loser exits cleanly with no work.
//
// Protocol — per-candidate temp + atomic exclusive link + read-back:
//
//   1. If <taskDir>/claimed-<id>.lock holds a *live* PID, lose immediately.
//   2. Otherwise (no holder, holder is dead, or holder is unparseable —
//      stale claim), atomically clear the canonical lock *only if* its
//      contents still match what we observed (re-read + compare-and-unlink),
//      then write <taskDir>/claim-<id>-<pid>.tmp containing our PID, then
//      `fs.linkSync(tmp, canonical)`. POSIX link(2) is atomic *and*
//      exclusive: it fails with EEXIST if the destination already exists.
//      Whoever's link succeeds owns the slot; on EEXIST the loop retries
//      so a concurrent winner doesn't permanently wedge a candidate that
//      observed the same stale state.
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
//
// Failure modes on `acquireClaim`:
//   - returns a `Claim` — we own the slot
//   - returns `null` — contention only: a live holder is in place, or we
//     lost the EEXIST race to a concurrent winner
//   - throws — unexpected filesystem failure (permissions, disk full,
//     I/O error). Callers must NOT treat throws as contention; the
//     cross-process semantics only hold for the two well-defined returns.

export interface Claim {
  readonly pid: number;
  release(): void;
}

// Maximum acquire-loop iterations. The loop only re-enters on transient
// races (concurrent steal, EEXIST against a steal-in-progress). A bounded
// retry guards against a pathological FS state where each iteration sees
// a different "stale" PID forever; in practice the loop converges in 1-2
// iterations.
const ACQUIRE_MAX_RETRIES = 16;

export function acquireClaim(
  taskDir: string,
  taskId: string,
  pid: number = process.pid,
): Claim | null {
  const canonical = claimedFilePath(taskDir, taskId);

  for (let attempt = 0; attempt < ACQUIRE_MAX_RETRIES; attempt++) {
    // Live-holder check is a fast-path skip: the typical concurrent-spawn
    // case is "winner already in place, loser arrives". The exclusive
    // link below is the actual race-free linearization point — this read
    // just avoids unlinking a live holder's lock by mistake.
    //
    // `existing` is the raw token (or null for ENOENT). Garbage contents
    // (unparseable PID) are treated as stale: a previous crash mid-write
    // could leave them, and refusing to clear them would permanently
    // wedge the lock against linkSync's EEXIST.
    const existing = readClaimedFile(canonical);
    if (existing !== null) {
      const aliveHolderPid = existing.kind === "pid" && isProcessAlive(existing.pid)
        ? existing.pid
        : null;
      if (aliveHolderPid !== null) return null;

      // Stale-claim recovery — must verify that the canonical file still
      // matches what we just read before unlinking. Otherwise a
      // concurrent winner could replace the stale file between our read
      // and our unlink, and we'd evict them. Re-read; if it changed,
      // restart the loop with the new observation.
      const recheck = readClaimedFile(canonical);
      if (recheck === null) continue; // someone else cleared it; retry
      if (!sameToken(existing, recheck)) continue; // changed; restart
      if (recheck.kind === "pid" && isProcessAlive(recheck.pid)) return null;

      try {
        fs.unlinkSync(canonical);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // already cleared; retry
        throw err;
      }
    }

    const tmp = tmpClaimPath(taskDir, taskId, pid);
    fs.writeFileSync(tmp, `${pid}\n`, "utf8");

    // Atomic exclusive create via hardlink — fails with EEXIST if the
    // canonical path already exists. This is the linearization point.
    let linked = false;
    try {
      fs.linkSync(tmp, canonical);
      linked = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Always drop our temp; we hold no claim until link succeeds.
      try { fs.unlinkSync(tmp); } catch {}
      if (code === "EEXIST") {
        // Someone else won the race or replaced a stale lock. Retry —
        // the next iteration will see their live holder (lose) or
        // recover their stale claim.
        continue;
      }
      throw err;
    }

    if (linked) {
      // Read-back as defence in depth against filesystem weirdness. With
      // link(2)'s exclusive semantics, the recorded PID *must* be ours.
      const recorded = readClaimedFile(canonical);
      if (recorded === null || recorded.kind !== "pid" || recorded.pid !== pid) {
        try { fs.unlinkSync(tmp); } catch {}
        return null;
      }

      // The canonical path is now a hardlink to the same inode; unlink
      // the temp to keep the directory tidy.
      try { fs.unlinkSync(tmp); } catch {}

      return makeClaim(canonical, pid);
    }
  }

  // Exceeded retry budget — treat as contention so the caller exits
  // cleanly rather than crashing. This branch is reachable only under a
  // pathological FS state (the canonical lock keeps changing between
  // observations); in normal operation the loop converges in 1-2 passes.
  return null;
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
      const recorded = readClaimedFile(canonical);
      if (recorded === null || recorded.kind !== "pid" || recorded.pid !== ownerPid) {
        return;
      }
      try {
        fs.unlinkSync(canonical);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    },
  };
}

// Tagged result so callers can distinguish "absent" (ENOENT), "valid PID
// recorded", and "present but unparseable" (stale crash artefact). Treating
// unparseable contents as stale lets `acquireClaim` clear them and recover,
// rather than wedging on EEXIST forever.
type ClaimedFileToken =
  | { kind: "pid"; pid: number; raw: string }
  | { kind: "garbage"; raw: string };

function readClaimedFile(filePath: string): ClaimedFileToken | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.trim();
  // Strict positive integer — `parseInt` accepts leading garbage and
  // negatives; a process PID is always a positive integer.
  if (!/^[1-9]\d*$/.test(trimmed)) return { kind: "garbage", raw };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return { kind: "garbage", raw };
  return { kind: "pid", pid: n, raw };
}

function sameToken(a: ClaimedFileToken, b: ClaimedFileToken): boolean {
  return a.raw === b.raw;
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
