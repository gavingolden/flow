import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export interface VerifyGateResult {
  ok: boolean;
  output: string;
}

export async function runVerifyGate(cwd: string): Promise<VerifyGateResult> {
  const pkgJsonPath = path.join(cwd, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgJsonPath, "utf8");
  } catch (err) {
    return { ok: false, output: `cannot read package.json at ${pkgJsonPath}: ${err}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, output: `package.json at ${pkgJsonPath} is not valid JSON: ${err}` };
  }
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts ?? {};
  if (!scripts.verify) {
    return {
      ok: false,
      output: `package.json at ${pkgJsonPath} has no 'verify' npm script; add a 'verify' script that runs this repository's required validation checks (typecheck, tests, etc.)`,
    };
  }

  // execa 9.x throws on timeout and spawn failure (e.g. npm not on PATH).
  // Convert those into the deterministic { ok, output } contract — the
  // orchestrator relies on a non-throwing return for retry/surface logic.
  try {
    const result = await execa("npm", ["run", "verify"], {
      cwd,
      reject: false,
      all: true,
      timeout: 10 * 60 * 1000,
    });
    return {
      ok: result.exitCode === 0,
      output: result.all ?? result.stdout ?? "",
    };
  } catch (err) {
    const e = err as {
      all?: string;
      stdout?: string;
      stderr?: string;
      shortMessage?: string;
      message?: string;
    };
    return {
      ok: false,
      output:
        e.all ?? e.stdout ?? e.stderr ?? e.shortMessage ?? e.message ?? String(err),
    };
  }
}

const CAUTION_HEADER = "Pre-PR verify failed against pushed SHA — needs human review";

export async function surfaceVerifyFailureOnPr(
  prNumber: number,
  worktreePath: string,
  failureLog: string,
): Promise<void> {
  const view = await execa(
    "gh",
    ["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"],
    { cwd: worktreePath, reject: false },
  );
  if (view.exitCode !== 0) return;
  const updated = upsertCautionBlock(view.stdout ?? "", failureLog);
  await execa(
    "gh",
    ["pr", "edit", String(prNumber), "--body-file", "-"],
    { cwd: worktreePath, input: updated, reject: false },
  );
}

// Exported for unit-test reach (PR 8). Keep behaviour idempotent: a prior
// caution block produced by this helper is replaced, never stacked.
export function upsertCautionBlock(body: string, failureLog: string): string {
  const block = [
    "> [!CAUTION]",
    `> ${CAUTION_HEADER}`,
    "",
    "```text",
    failureLog,
    "```",
  ].join("\n");

  const sectionRe = /^## Manual validation\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m;
  const match = body.match(sectionRe);
  if (!match) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}\n\n## Manual validation\n\n${block}\n`;
  }
  const matched = match[0];
  // Strip any prior caution block we wrote (idempotency). Match the exact
  // shape emitted in `block` above — the opening ` ```text ` fence is
  // anchored explicitly so removal runs through the closing fence rather
  // than stopping at the opening one.
  const priorRe = new RegExp(
    `\\n*> \\[!CAUTION\\]\\n> ${escapeRegex(CAUTION_HEADER)}\\n\\n\`\`\`text\\n[\\s\\S]*?\\n\`\`\`(?=\\n|$)`,
  );
  const cleaned = matched.replace(priorRe, "\n").replace(/\s+$/, "");
  return body.replace(matched, `${cleaned}\n\n${block}\n`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
