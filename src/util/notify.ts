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
}

// `ReadonlySet<TaskStatus>` makes adding a non-`TaskStatus` literal a
// compile error — the set's membership is the only place new attention
// statuses are wired, and the type system enforces that every entry is a
// status the orchestrator can actually transition to today. PR 12 will
// add `plan-pending-review` here in the same change that adds it to
// `TASK_STATUSES`.
export const NOTIFY_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "needs-human",
  "gated",
  "merged",
  "aborted",
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
};

const MESSAGE_MAX_CHARS = 120;

export function buildPayload(
  args: NotifyArgs,
  taskBody?: string,
): { title: string; subtitle: string; message: string } {
  const title = `flow: ${args.status}`;
  const subtitle = args.task.frontmatter.id;
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
    const url = await this.resolvePrUrl(args.task);
    const backend = await this.resolveBackend();
    if (backend === "terminal-notifier") {
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
    const script =
      `display notification "${escapeForAppleScript(payload.message)}" ` +
      `with title "${escapeForAppleScript(payload.title)}" ` +
      `subtitle "${escapeForAppleScript(payload.subtitle)}"`;
    this.spawnDetached("osascript", ["-e", script]);
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
