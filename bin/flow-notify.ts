#!/usr/bin/env bun
/**
 * Fire a macOS notification when the supervisor reaches a terminal end
 * state (MERGED / gated / NEEDS HUMAN).
 *
 * Carries forward the legacy `src/util/notify.ts` behaviour from old
 * PR 17 into the tmux supervisor design (PR 10):
 *
 * - Opt-in via `FLOW_NOTIFY=1`. Anything else (unset, "0", "true", …)
 *   is a no-op so a default install never spams the user.
 * - darwin-only. Other platforms exit 0 silently — the supervisor must
 *   never have its end-state path broken by a notifier failure on a
 *   non-mac host.
 * - Backend: `terminal-notifier` preferred (supports `-open` for
 *   click-through to the PR), `osascript display notification` fallback
 *   (always present on darwin).
 * - Detached + fire-and-forget. Spawn errors are swallowed; the helper
 *   returns 0 even if the notification never appears.
 *
 * Usage:
 *   flow-notify --status <merged|gated|needs-human>
 *               [--slug <slug>] [--reason <text>] [--url <url>]
 *
 * `--slug` is optional: when omitted, the helper auto-resolves the
 * supervisor's slug from `$TMUX_PANE`'s `@flow-slug` window option.
 * Null result is silently OK — the notification's subtitle just stays
 * empty rather than failing the helper.
 *
 * Exit codes:
 *   0 — notification dispatched, suppressed (no opt-in / non-darwin),
 *       or backend spawn already kicked off (we don't wait).
 *   2 — argument parsing error. (Notification failures are never an
 *       exit-2 — they exit 0 to keep the supervisor's terminal path
 *       clean.)
 */

import { spawn } from "node:child_process";
import { resolveSlugFromPane } from "./lib/tmux";

const VALID_STATUSES = new Set(["merged", "gated", "needs-human"]);
const MESSAGE_MAX_CHARS = 120;

type Args = {
  status: string;
  slug?: string;
  reason?: string;
  url?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--status":
        out.status = value;
        break;
      case "--slug":
        out.slug = value;
        break;
      case "--reason":
        out.reason = value;
        break;
      case "--url":
        out.url = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.status) {
    return { error: "--status is required" };
  }
  if (!VALID_STATUSES.has(out.status)) {
    return {
      error: `--status must be one of ${[...VALID_STATUSES].join(", ")}, got '${out.status}'`,
    };
  }
  return out as Args;
}

export type Payload = { title: string; subtitle: string; message: string };

export function buildPayload(args: Args): Payload {
  const title = `flow: ${args.status}`;
  const subtitle = args.slug ?? "";
  const reason = args.reason?.trim();
  const message =
    reason && reason.length > 0 ? collapseAndTruncate(reason) : "(no reason)";
  return { title, subtitle, message };
}

function collapseAndTruncate(s: string): string {
  const collapsed = s.replace(/[\r\n]+/g, " ").trim();
  if (collapsed.length <= MESSAGE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, MESSAGE_MAX_CHARS)}…`;
}

// Order matters: escape backslash first so a later `"` → `\"` rewrite
// doesn't get its inserted backslash double-escaped.
export function escapeForAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

export function buildOsascriptScript(payload: Payload): string {
  const subtitleClause =
    payload.subtitle.length > 0
      ? ` subtitle "${escapeForAppleScript(payload.subtitle)}"`
      : "";
  return (
    `display notification "${escapeForAppleScript(payload.message)}" ` +
    `with title "${escapeForAppleScript(payload.title)}"` +
    subtitleClause
  );
}

export function buildTerminalNotifierArgs(
  payload: Payload,
  url: string | undefined,
): string[] {
  const argv = ["-title", payload.title];
  if (payload.subtitle.length > 0) {
    argv.push("-subtitle", payload.subtitle);
  }
  argv.push("-message", payload.message);
  if (url && url.length > 0) {
    argv.push("-open", url);
  }
  return argv;
}

export type Deps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasTerminalNotifier: () => boolean;
  spawnDetached: (cmd: string, args: readonly string[]) => void;
  /**
   * Slug fallback when `--slug` is omitted. Defaults to
   * `resolveSlugFromPane()` so the supervisor's terminal-state
   * notifications get the right window subtitle even when its
   * per-Bash-call shell loses any `SLUG=…` it sets.
   */
  resolveSlug: () => string | null;
};

export type DispatchResult =
  | { dispatched: false; reason: "no-opt-in" | "non-darwin" }
  | {
      dispatched: true;
      backend: "terminal-notifier" | "osascript";
      argv: string[];
    };

export function dispatch(args: Args, deps: Deps): DispatchResult {
  if (deps.env.FLOW_NOTIFY !== "1") {
    return { dispatched: false, reason: "no-opt-in" };
  }
  if (deps.platform !== "darwin") {
    return { dispatched: false, reason: "non-darwin" };
  }
  // Backfill the slug from the pane when --slug was omitted. A null
  // result is fine — the helper is fire-and-forget by design and the
  // subtitle just stays empty.
  const resolved =
    args.slug !== undefined
      ? args
      : { ...args, slug: deps.resolveSlug() ?? undefined };
  const payload = buildPayload(resolved);
  if (deps.hasTerminalNotifier()) {
    const argv = buildTerminalNotifierArgs(payload, resolved.url);
    deps.spawnDetached("terminal-notifier", argv);
    return { dispatched: true, backend: "terminal-notifier", argv };
  }
  const argv = ["-e", buildOsascriptScript(payload)];
  deps.spawnDetached("osascript", argv);
  return { dispatched: true, backend: "osascript", argv };
}

function defaultHasTerminalNotifier(): boolean {
  // `which` exits 0 with a path on hit, non-zero on miss. We don't read
  // the path — only the exit code matters.
  const result = Bun.spawnSync(["which", "terminal-notifier"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function defaultSpawnDetached(cmd: string, args: readonly string[]): void {
  // Detached fire-and-forget: an unhandled spawn error otherwise emits
  // `error` on the child and crashes the supervisor's Bash tool call.
  // Swallow it — a missing notifier banner must never break a terminal
  // print.
  const child = spawn(cmd, [...args], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function run(argv: string[], deps?: Partial<Deps>): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-notify: ${parsed.error}`);
    console.error(
      "usage: flow-notify --status <merged|gated|needs-human> [--slug <slug>] [--reason <text>] [--url <url>]",
    );
    return 2;
  }
  const resolved: Deps = {
    platform: deps?.platform ?? process.platform,
    env: deps?.env ?? process.env,
    hasTerminalNotifier:
      deps?.hasTerminalNotifier ?? defaultHasTerminalNotifier,
    spawnDetached: deps?.spawnDetached ?? defaultSpawnDetached,
    resolveSlug: deps?.resolveSlug ?? (() => resolveSlugFromPane()),
  };
  dispatch(parsed, resolved);
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
