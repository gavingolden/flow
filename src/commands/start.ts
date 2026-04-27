import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import pc from "picocolors";

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

  try {
    await execa(
      "claude",
      [
        trimmed,
        "--append-system-prompt", systemPrompt,
        // Triage's only side effect is writing one task.md; the system
        // prompt forbids code edits. acceptEdits keeps the Write tool from
        // gating the user behind plan-mode approval every invocation.
        "--permission-mode", "acceptEdits",
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
  } catch (err) {
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (typeof exitCode === "number") process.exit(exitCode);
    throw err;
  }
}

async function findGitRoot(): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
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
