import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { execa } from "execa";
import type { TaskStatus } from "../state/phases.js";
import type { Task } from "../state/task-file.js";

export interface NotifyArgs {
  task: Task;
  status: TaskStatus;
  reason?: string;
}

export interface Notifier {
  notify(args: NotifyArgs): Promise<void>;
  // Synchronous fire-and-forget for callers that run inside Node's
  // `'exit'` event, where the event loop is already torn down and any
  // `await` is silently dropped. Implementations must reach `spawn()`
  // without yielding — no `await`, no Promise chaining, no async lookup
  // (`which`, `gh repo view`). The async `notify()` may have warmed
  // process-lifetime caches (e.g. selected backend); the sync path uses
  // those if present and otherwise falls back to a backend that is
  // guaranteed to exist on the host (`osascript` on darwin).
  notifySync(args: NotifyArgs): void;
}

// `ReadonlySet<TaskStatus>` makes adding a non-`TaskStatus` literal a
// compile error — the set's membership is the only place new attention
// statuses are wired, and the type system enforces that every entry is a
// status the orchestrator can actually transition to today.
export const NOTIFY_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "needs-human",
  "gated",
  "merged",
  "aborted",
  "plan-pending-review",
]);

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface NotifyDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  which: (cmd: string) => Promise<string | null>;
  ghRepoView: (cwd: string) => Promise<string | null>;
}

export const NoopNotifier: Notifier = {
  async notify() {},
  notifySync() {},
};

const MESSAGE_MAX_CHARS = 120;

export function buildPayload(
  args: NotifyArgs,
  taskBody?: string,
): { title: string; subtitle: string; message: string } {
  const title = `flow: ${args.status}`;
  const subtitle = args.task.frontmatter.id;
  // The plan-pending-review checkpoint is the one status whose default
  // payload (`reason` = "intent: feature") doesn't tell the user what to
  // do next. Override with the resume affordance so the banner is
  // actionable in isolation; users won't always have `/flow-status` open
  // when the notification fires.
  if (args.status === "plan-pending-review") {
    return {
      title,
      subtitle,
      message: `plan ready — /flow-approve ${subtitle} or /flow-revise ${subtitle}`,
    };
  }
  const reason = args.reason?.trim();
  let message: string;
  if (reason && reason.length > 0) {
    message = collapseAndTruncate(reason);
  } else {
    const fromBody = extractFirstUserPromptLine(taskBody ?? args.task.body);
    message = fromBody ? collapseAndTruncate(fromBody) : "(no reason)";
  }
  return { title, subtitle, message };
}

function collapseAndTruncate(s: string): string {
  const collapsed = s.replace(/[\r\n]+/g, " ").trim();
  if (collapsed.length <= MESSAGE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, MESSAGE_MAX_CHARS)}…`;
}

function extractFirstUserPromptLine(body: string): string | null {
  const re = /^## User prompt\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m;
  const match = body.match(re);
  if (!match) return null;
  const section = match[1] ?? "";
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return null;
}

function buildOsascriptScript(payload: {
  title: string;
  subtitle: string;
  message: string;
}): string {
  return (
    `display notification "${escapeForAppleScript(payload.message)}" ` +
    `with title "${escapeForAppleScript(payload.title)}" ` +
    `subtitle "${escapeForAppleScript(payload.subtitle)}"`
  );
}

// Order matters: escape backslash first so a later `"` → `\"` rewrite
// doesn't get its inserted backslash double-escaped.
export function escapeForAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

async function defaultWhich(cmd: string): Promise<string | null> {
  try {
    const result = await execa("which", [cmd], { reject: false });
    if (result.exitCode !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function defaultGhRepoView(cwd: string): Promise<string | null> {
  try {
    const result = await execa(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { cwd, reject: false },
    );
    if (result.exitCode !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

class ActiveNotifier implements Notifier {
  private backend: "terminal-notifier" | "osascript" | null = null;
  private repoCache = new Map<string, string | null>();

  constructor(private readonly deps: NotifyDeps) {}

  async notify(args: NotifyArgs): Promise<void> {
    if (!NOTIFY_STATUSES.has(args.status)) return;
    const payload = buildPayload(args, args.task.body);
    // Resolve backend before URL: only `terminal-notifier` can act on
    // the click-to-open URL, so the `gh repo view` round-trip is
    // wasted work on the `osascript` fallback path.
    const backend = await this.resolveBackend();
    if (backend === "terminal-notifier") {
      const url = await this.resolvePrUrl(args.task);
      const argv = [
        "-title",
        payload.title,
        "-subtitle",
        payload.subtitle,
        "-message",
        payload.message,
      ];
      if (url) argv.push("-open", url);
      this.spawnDetached("terminal-notifier", argv);
      return;
    }
    this.spawnDetached("osascript", ["-e", buildOsascriptScript(payload)]);
  }

  // Synchronous variant for the `'exit'` reaper path. Cannot `await` —
  // any continuation queued after a yield will be silently dropped when
  // Node finishes the exit handler and tears down the loop. Therefore:
  // no `which`, no `gh repo view`. We reuse a backend cached by an
  // earlier async call when possible; otherwise we go straight to
  // `osascript` (always present on darwin). PR URL is only emitted when
  // the repo cache already has an answer for `target_repo` — we never
  // block on the network here.
  notifySync(args: NotifyArgs): void {
    if (!NOTIFY_STATUSES.has(args.status)) return;
    const payload = buildPayload(args, args.task.body);
    const backend = this.backend ?? "osascript";
    if (backend === "terminal-notifier") {
      const cachedOwner = this.repoCache.get(args.task.frontmatter.target_repo);
      const url =
        args.task.frontmatter.pr != null && cachedOwner
          ? `https://github.com/${cachedOwner}/pull/${args.task.frontmatter.pr}`
          : null;
      const argv = [
        "-title",
        payload.title,
        "-subtitle",
        payload.subtitle,
        "-message",
        payload.message,
      ];
      if (url) argv.push("-open", url);
      this.spawnDetached("terminal-notifier", argv);
      return;
    }
    this.spawnDetached("osascript", ["-e", buildOsascriptScript(payload)]);
  }

  private async resolveBackend(): Promise<"terminal-notifier" | "osascript"> {
    if (this.backend) return this.backend;
    const tnPath = await this.deps.which("terminal-notifier");
    this.backend = tnPath ? "terminal-notifier" : "osascript";
    return this.backend;
  }

  private async resolvePrUrl(task: Task): Promise<string | null> {
    if (task.frontmatter.pr == null) return null;
    const cwd = task.frontmatter.target_repo;
    if (!this.repoCache.has(cwd)) {
      const owner = await this.deps.ghRepoView(cwd);
      this.repoCache.set(cwd, owner);
    }
    const owner = this.repoCache.get(cwd) ?? null;
    if (!owner) return null;
    return `https://github.com/${owner}/pull/${task.frontmatter.pr}`;
  }

  private spawnDetached(cmd: string, args: readonly string[]): void {
    const child = this.deps.spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    // Without an `error` listener, an async spawn failure (binary
    // missing on PATH after the `which` cache was warmed, sandbox
    // EPERM, fork failure under load) emits `error` on the child and,
    // un-listened, propagates as `uncaughtException` — which would
    // crash the orchestrator. The fire-and-forget contract is "a
    // failed banner never poisons a status transition," so swallow.
    child.on("error", () => {});
    child.unref();
  }
}

export function createNotifier(deps?: Partial<NotifyDeps>): Notifier {
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  if (platform !== "darwin") return NoopNotifier;
  if (env.FLOW_NOTIFY !== "1") return NoopNotifier;
  const resolved: NotifyDeps = {
    platform,
    env,
    spawn: deps?.spawn ?? (nodeSpawn as SpawnFn),
    which: deps?.which ?? defaultWhich,
    ghRepoView: deps?.ghRepoView ?? defaultGhRepoView,
  };
  return new ActiveNotifier(resolved);
}
