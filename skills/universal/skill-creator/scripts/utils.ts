import { readFileSync } from "node:fs";
import { join } from "node:path";

// Eval pipeline types (run_eval, run_loop, improve_description)
export interface EvalItem {
  query: string;
  should_trigger: boolean;
}

export interface EvalResult {
  query: string;
  should_trigger: boolean;
  trigger_rate: number;
  triggers: number;
  runs: number;
  pass: boolean;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
}

// Grading JSON types (aggregate_benchmark, generate_review)
export interface GradingExpectation {
  text: string;
  passed: boolean;
  evidence?: string;
}

export interface GradingData {
  summary?: {
    pass_rate?: number;
    passed?: number;
    failed?: number;
    total?: number;
  };
  timing?: {
    total_duration_seconds?: number;
  };
  execution_metrics?: {
    total_tool_calls?: number;
    output_chars?: number;
    errors_encountered?: number;
  };
  expectations?: GradingExpectation[];
  user_notes_summary?: {
    uncertainties?: string[];
    needs_review?: string[];
    workarounds?: string[];
  };
}

export function parseSkillMd(skillPath: string): {
  name: string;
  description: string;
  content: string;
} {
  const content = readFileSync(join(skillPath, "SKILL.md"), "utf-8");
  const lines = content.split("\n");

  if (lines[0].trim() !== "---") {
    throw new Error("SKILL.md missing frontmatter (no opening ---)");
  }

  let endIdx: number | undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === undefined) {
    throw new Error("SKILL.md missing frontmatter (no closing ---)");
  }

  let name = "";
  let description = "";
  const frontmatterLines = lines.slice(1, endIdx);
  let i = 0;

  while (i < frontmatterLines.length) {
    const line = frontmatterLines[i];
    if (line.startsWith("name:")) {
      name = line
        .slice("name:".length)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    } else if (line.startsWith("description:")) {
      const value = line.slice("description:".length).trim();
      if ([">", "|", ">-", "|-"].includes(value)) {
        const continuationLines: string[] = [];
        i++;
        while (
          i < frontmatterLines.length &&
          (frontmatterLines[i].startsWith("  ") || frontmatterLines[i].startsWith("\t"))
        ) {
          continuationLines.push(frontmatterLines[i].trim());
          i++;
        }
        description = continuationLines.join(" ");
        continue;
      } else {
        description = value.replace(/^['"]|['"]$/g, "");
      }
    }
    i++;
  }

  return { name, description, content };
}
