import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import pc from "picocolors";
import { findGitRoot } from "../util/git.js";
import { readTask } from "../state/task-file.js";

export async function startCommand(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    console.error(pc.red("error: a prompt is required"));
    process.exit(1);
  }

  const repoRoot = await findGitRoot();
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

  // Snapshot before triage so we can identify the file it just wrote.
  // File-diff is more reliable than asking the model to echo the id.
  const beforeIds = await listTaskMdFilenames(tasksDir);

  try {
    await execa(
      "claude",
      [
        trimmed,
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
      { cwd: repoRoot, stdio: "inherit" },
    );
  } catch (err) {
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (typeof exitCode === "number") process.exit(exitCode);
    throw err;
  }

  await printNextCommand(tasksDir, beforeIds);
}

async function listTaskMdFilenames(tasksDir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(tasksDir);
    return new Set(entries.filter((e) => e.endsWith(".md")));
  } catch {
    return new Set();
  }
}

async function printNextCommand(
  tasksDir: string,
  beforeIds: Set<string>,
): Promise<void> {
  const after = await listTaskMdFilenames(tasksDir);
  const created = [...after].filter((name) => !beforeIds.has(name));

  if (created.length === 0) {
    console.error("");
    console.error(
      pc.yellow("flow: triage exited without creating a task file"),
    );
    return;
  }

  // Multiple new files is unusual but possible if the user re-ran triage
  // in a tight loop. Prefer one whose id contains today's date prefix.
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const chosen =
    created.find((name) => name.startsWith(todayPrefix)) ?? created[0]!;

  try {
    const task = await readTask(path.join(tasksDir, chosen));
    console.error("");
    console.error(pc.green(`flow: next — flow run ${task.frontmatter.id}`));
  } catch {
    console.error("");
    console.error(pc.yellow(`flow: created ${chosen} but could not parse id`));
  }
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
