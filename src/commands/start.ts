import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import pc from "picocolors";
import { findCanonicalRoot } from "../util/git.js";
import { resolvePromptSource } from "./resolve-prompt.js";
import {
  TRIAGE_SENTINEL_ENV,
  cleanupSentinel,
  createSentinelPath,
  readSentinelTaskId,
} from "./triage-sentinel.js";

export async function startCommand(argvParts: string[]): Promise<void> {
  const resolved = await resolvePromptSource(argvParts, {
    stdin: process.stdin,
    stderr: process.stderr,
  });
  if (!resolved.ok) {
    console.error(pc.red(resolved.message));
    process.exit(resolved.exitCode);
  }
  // Not necessarily trimmed — the stdin path preserves leading whitespace and
  // only strips trailing newlines. The variable is named `prompt`, not
  // `trimmed`, to avoid suggesting another `.trim()` is safe to apply later.
  const prompt = resolved.prompt;

  // Canonicalise to the primary worktree so a `flow start` invoked from
  // inside a child worktree still anchors the new task to the main repo's
  // `.orchestrator/`.
  const repoRoot = await findCanonicalRoot();
  if (!repoRoot) {
    console.error(
      pc.red("error: flow must be run from inside a git repository"),
    );
    process.exit(1);
  }

  const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  const systemPrompt = await loadTriageSystemPrompt(repoRoot);

  console.error(pc.dim(`flow: target repo  ${repoRoot}`));
  console.error(pc.dim(`flow: tasks dir    ${tasksDir}`));
  console.error(pc.dim("flow: launching triage session..."));
  console.error("");

  // Session-scoped sentinel: the parent generates a unique scratch path, the
  // triage subprocess writes the new task id there as its final action, and
  // we read exactly that file. This replaces a directory-diff that
  // misattributed sibling sessions' task ids when two `flow start` runs
  // overlapped.
  const sentinelPath = createSentinelPath();

  let triageExitCode: number | undefined;
  try {
    await execa(
      "claude",
      [
        prompt,
        "--append-system-prompt", systemPrompt,
        // `default` opts out of plan-mode auto-entry (which previously
        // hijacked triage into implementation) while still surfacing each
        // tool call for the user to confirm. Auto-accepting writes was
        // smoother UX but hid actions the user should see.
        "--permission-mode", "default",
        // Structural guardrail: triage cannot modify existing files even
        // if the system prompt is misread. Write stays available so
        // task.md still gets created.
        "--disallowed-tools", "Edit,MultiEdit,NotebookEdit",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, [TRIAGE_SENTINEL_ENV]: sentinelPath },
      },
    );
  } catch (err) {
    triageExitCode = (err as { exitCode?: number }).exitCode;
    if (typeof triageExitCode !== "number") {
      await cleanupSentinel(sentinelPath);
      throw err;
    }
  }

  if (triageExitCode === undefined) {
    const id = await readSentinelTaskId(sentinelPath);
    if (id === null) {
      console.error("");
      console.error(
        pc.yellow("flow: triage exited without creating a task file"),
      );
    } else {
      console.error("");
      console.error(pc.green(`flow: next — flow run ${id}`));
    }
  }

  await cleanupSentinel(sentinelPath);
  if (triageExitCode !== undefined) process.exit(triageExitCode);
}

async function loadTriageSystemPrompt(repoRoot: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works for both `tsx src/commands/start.ts` (→ ../../templates) and
  // `node dist/commands/start.js` (→ ../../templates relative to dist/).
  const templatePath = path.resolve(
    here,
    "..",
    "..",
    "templates",
    "triage-system-prompt.md",
  );
  const raw = await fs.readFile(templatePath, "utf8");
  return raw.replaceAll("${REPO_ROOT}", repoRoot);
}
