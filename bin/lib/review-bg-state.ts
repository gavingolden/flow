/**
 * State file + ownership-checked writes for the background Gemini helpers
 * (`flow-review-bg`). Pure with injected IO: nothing here spawns or reads the
 * real filesystem unless the caller takes the `realStateIO` default.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { classifyDelegateSkip, type SkipClass } from "./delegate-skip-class";
import { livenessOf, type Liveness } from "./liveness";

export type BgHelper = "gemini-lens" | "gemini-intent-guess";
export type BgOutcome =
  | "pending"
  | "complete"
  | "skipped"
  | "helper-exited-without-envelope"
  | "lens-timeout"
  | "intent-guess-timeout";

export type BgHelperState = {
  status: "running" | "skipped" | "done";
  startedAtSec: number;
  giveUpAtSec: number | null;
  envelope: string;
  out: string;
  log: string;
  outcome?: BgOutcome;
  skipReason?: string;
  skipClass?: SkipClass;
};

export type ReviewBgState = {
  version: 1;
  generation: string;
  head_sha: string | null;
  scope: string | null;
  review_started_at: string | null;
  configPath: string;
  // Stamped by the first `wait` snapshot (epoch sec); absent = nobody waited.
  awaitedAt?: number;
  watchdog: { pid: number; pidStartEpoch: number | null } | null;
  diffSnapshot: string | null;
  helpers: Record<BgHelper, BgHelperState>;
};

export const REVIEW_BG_STATE_FILE = "review-bg.json";
export const BG_HELPERS: readonly BgHelper[] = [
  "gemini-lens",
  "gemini-intent-guess",
];

export type StateIO = {
  readFile: (path: string) => string | null;
  writeFile: (path: string, contents: string) => void;
  rename: (from: string, to: string) => void;
  removeFile: (path: string) => void;
  removeDir: (dir: string) => void;
  mkdirp: (dir: string) => void;
  fileExists: (path: string) => boolean;
  copyFile: (from: string, to: string) => void;
};

export const realStateIO = (): StateIO => ({
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, c) => writeFileSync(p, c),
  rename: (a, b) => renameSync(a, b),
  removeFile: (p) => void rmSync(p, { force: true }),
  removeDir: (d) => rmdirSync(d),
  mkdirp: (d) => void mkdirSync(d, { recursive: true }),
  fileExists: (p) => existsSync(p),
  copyFile: (a, b) => copyFileSync(a, b),
});

export function bgPaths(worktree: string) {
  const tmp = join(worktree, ".flow-tmp");
  const scratch = join(tmp, "scratch", "review-bg");
  return {
    tmp,
    scratch,
    state: join(tmp, REVIEW_BG_STATE_FILE),
    snapshot: join(scratch, "diff.txt"),
    superviseLog: join(scratch, "supervise.log"),
    reviewScope: join(tmp, "review-scope.json"),
    intentResolution: join(tmp, "intent-resolution.json"),
    diff: join(tmp, "diff.txt"),
    lensOut: join(tmp, "agent-output-gemini.json"),
    intentOut: join(tmp, "intent-guess-gemini.json"),
    lensEnvelope: join(tmp, "gemini-lens-envelope.json"),
    intentEnvelope: join(tmp, "intent-guess-envelope.json"),
    lensLog: join(scratch, "gemini-lens.log"),
    intentLog: join(scratch, "gemini-intent-guess.log"),
  };
}

// A run's result files, cleared by exact name when a pass is superseded.
export function bgRunOutputs(worktree: string): string[] {
  const p = bgPaths(worktree);
  return [p.lensEnvelope, p.intentEnvelope, p.lensOut, p.intentOut];
}

export const MISSING_ENVELOPE_REASON = "helper-exited-without-envelope";

// The helper paths a run always uses, rebuilt from the worktree layout so a
// state file written by an agent cannot redirect them elsewhere on disk.
export function helperPaths(
  worktree: string,
  helper: BgHelper,
): { envelope: string; out: string; log: string } {
  const p = bgPaths(worktree);
  return helper === "gemini-lens"
    ? { envelope: p.lensEnvelope, out: p.lensOut, log: p.lensLog }
    : { envelope: p.intentEnvelope, out: p.intentOut, log: p.intentLog };
}

// `--config` is the default flow config or a file under the worktree.
export function isTrustedConfigPath(
  worktree: string,
  configPath: string,
): boolean {
  if (configPath === "") return false;
  const abs = resolve(configPath);
  return (
    abs === resolve(homedir(), ".flow", "config.json") ||
    abs.startsWith(`${resolve(worktree)}${sep}`)
  );
}

// Lens: delegate timeout + the helper's 120 s retry rung + 300 s grace.
// Intent guess: delegate timeout + 300 s grace.
export function giveUpSec(helper: BgHelper, timeoutSec: number): number {
  return helper === "gemini-lens" ? timeoutSec + 120 + 300 : timeoutSec + 300;
}

export function readReviewBgState(text: string | null): ReviewBgState | null {
  if (text === null) return null;
  try {
    const s = JSON.parse(text) as ReviewBgState;
    if (s?.version !== 1 || typeof s.generation !== "string") return null;
    if (!s.helpers?.["gemini-lens"] || !s.helpers["gemini-intent-guess"]) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function writeAtomic(io: StateIO, path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  io.writeFile(tmp, text);
  io.rename(tmp, path);
}

export function writeReviewBgState(
  worktree: string,
  state: ReviewBgState,
  io: StateIO,
): void {
  writeAtomic(io, bgPaths(worktree).state, `${JSON.stringify(state)}\n`);
}

export function ownsState(
  worktree: string,
  generation: string,
  io: StateIO,
): boolean {
  const s = readReviewBgState(io.readFile(bgPaths(worktree).state));
  return s !== null && s.generation === generation;
}

// Re-reads the state and writes only when this writer's generation still owns
// it, so a superseded watchdog or a stale `wait` never clobbers a newer run.
export function writeIfOwner(
  worktree: string,
  generation: string,
  mutate: (state: ReviewBgState) => void,
  io: StateIO,
): ReviewBgState | null {
  const s = readReviewBgState(io.readFile(bgPaths(worktree).state));
  if (s === null || s.generation !== generation) return null;
  mutate(s);
  writeReviewBgState(worktree, s, io);
  return s;
}

export function writeEnvelopeIfOwner(
  worktree: string,
  generation: string,
  envelopePath: string,
  envelope: Record<string, unknown>,
  io: StateIO,
): boolean {
  if (!ownsState(worktree, generation, io)) return false;
  writeAtomic(io, envelopePath, `${JSON.stringify(envelope)}\n`);
  return true;
}

export function watchdogLiveness(
  wd: ReviewBgState["watchdog"],
  isAlive?: (pid: number) => boolean,
  pidStart?: (pid: number) => number | null,
): Liveness {
  if (wd === null) return "stale";
  if (wd.pidStartEpoch === null) {
    // No recorded start time: fall back to a bare existence probe.
    return livenessOf(
      { pid: wd.pid, procStartedAt: 0 },
      { isAlive, pidStartEpoch: () => 0 },
    );
  }
  return livenessOf(
    { pid: wd.pid, procStartedAt: wd.pidStartEpoch },
    { isAlive, pidStartEpoch: pidStart },
  );
}

export function readScope(
  io: StateIO,
  worktree: string,
): { head_sha: string | null; scope: string | null; started: string | null } {
  try {
    const p = JSON.parse(io.readFile(bgPaths(worktree).reviewScope) ?? "");
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      head_sha: str(p.head_sha),
      scope: str(p.scope),
      started: str(p.started_at),
    };
  } catch {
    return { head_sha: null, scope: null, started: null };
  }
}

export type ResolvedSkip = {
  ran: boolean;
  skip_reason: string | null;
  skip_class: SkipClass | null;
};

// Telemetry-side resolver: what happened to a background helper for the
// review at `headSha`, from the state file plus the helper's envelope text.
export function resolveGeminiSkip(
  helper: BgHelper,
  state: ReviewBgState | null,
  envelopeText: string | null,
  headSha: string | null,
): ResolvedSkip {
  const skip = (reason: string, cls?: SkipClass | null): ResolvedSkip => ({
    ran: false,
    skip_reason: reason,
    skip_class: cls ?? classifyDelegateSkip(reason),
  });
  if (state === null || state.head_sha !== headSha) {
    return skip("gemini-not-launched");
  }
  // A launched helper nobody waited on never reached Step 3.5, even when its
  // envelope landed later.
  if (
    state.awaitedAt === undefined &&
    state.helpers[helper].status !== "skipped"
  ) {
    return skip("gemini-not-awaited", "ran-unusable");
  }
  try {
    const e = JSON.parse(envelopeText ?? "") as Record<string, unknown>;
    if (e.ran === true) {
      return { ran: true, skip_reason: null, skip_class: null };
    }
    if (e.ran === false && typeof e.skipReason === "string") {
      const cls =
        e.skipClass === "environment" || e.skipClass === "ran-unusable"
          ? e.skipClass
          : null;
      return skip(e.skipReason, cls);
    }
  } catch {
    // no complete envelope — fall through to the state
  }
  const h = state.helpers[helper];
  if (h.status === "running") return skip("gemini-not-awaited", "ran-unusable");
  return skip(h.skipReason ?? MISSING_ENVELOPE_REASON, h.skipClass);
}
