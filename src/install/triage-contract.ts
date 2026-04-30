import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The single literal token that both the system prompt and the SKILL.md
// embed to pull in the shared triage rules. Keep this as a literal string
// match (no regex) so a stray whitespace difference in the source file
// surfaces as a missing include rather than a silent partial substitution.
export const INCLUDE_MARKER = "<!-- include: triage-contract.md -->";

export interface RenderTriageOptions {
  repoRoot: string;
  /**
   * Override the location of `templates/triage-contract.md`. Tests inject
   * this; production callers let it resolve from the install layout.
   */
  contractPath?: string;
}

/**
 * Resolves the partial body and substitutes both the include marker and
 * `${REPO_ROOT}` in `raw`. The two front doors (system prompt, skill body)
 * call this with their own raw input so the contract bytes are produced
 * once from one source file.
 */
export async function renderWithTriageContract(
  raw: string,
  options: RenderTriageOptions,
): Promise<string> {
  if (!raw.includes(INCLUDE_MARKER)) {
    return raw.replaceAll("${REPO_ROOT}", options.repoRoot);
  }
  const contractPath = options.contractPath ?? defaultContractPath();
  const partial = await fs.readFile(contractPath, "utf8");
  // The partial may itself reference `${REPO_ROOT}`; substitute after the
  // include so a single `replaceAll` covers both consumers' references.
  const expanded = raw.replaceAll(INCLUDE_MARKER, partial.trimEnd());
  return expanded.replaceAll("${REPO_ROOT}", options.repoRoot);
}

function defaultContractPath(): string {
  // Works for both `tsx src/install/triage-contract.ts` (→ ../../templates)
  // and `node dist/install/triage-contract.js` (same relative layout under
  // dist/).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "templates", "triage-contract.md");
}
