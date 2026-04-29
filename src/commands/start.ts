import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import pc from "picocolors";
import { findCanonicalRoot } from "../util/git.js";

export async function startCommand(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    console.error(pc.red("error: a prompt is required"));
    process.exit(1);
  }

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
