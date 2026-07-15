import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { EvalResult } from "./utils.ts";
import { parseSkillMd } from "./utils.ts";

async function callClaude(
  prompt: string,
  model?: string,
  timeout = 300,
): Promise<string> {
  const cmd = ["claude", "-p", "--output-format", "text"];
  if (model) cmd.push("--model", model);

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"),
  );

  const proc = Bun.spawn(cmd, {
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timeoutId = setTimeout(() => proc.kill(), timeout * 1000);
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  clearTimeout(timeoutId);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude -p exited ${exitCode}\nstderr: ${stderr}`);
  }

  return stdout;
}

interface EvalResults {
  results: Array<{
    query: string;
    should_trigger: boolean;
    pass: boolean;
    triggers: number;
    runs: number;
  }>;
  summary: { passed: number; failed: number; total: number };
  description?: string;
}

interface HistoryEntry {
  description: string;
  train_passed?: number;
  train_total?: number;
  test_passed?: number;
  test_total?: number;
  passed?: number;
  failed?: number;
  total?: number;
  results?: EvalResult[];
  note?: string;
}

interface ImproveTranscript {
  iteration?: number;
  prompt: string;
  response: string;
  parsed_description: string;
  char_count: number;
  over_limit: boolean;
  rewrite_prompt?: string;
  rewrite_response?: string;
  rewrite_description?: string;
  rewrite_char_count?: number;
  final_description?: string;
}

export async function improveDescription(opts: {
  skillName: string;
  skillContent: string;
  currentDescription: string;
  evalResults: EvalResults;
  history: HistoryEntry[];
  model: string;
  testResults?: EvalResults;
  logDir?: string;
  iteration?: number;
}): Promise<string> {
  const {
    skillName,
    skillContent,
    currentDescription,
    evalResults,
    history,
    model,
    testResults,
    logDir,
    iteration,
  } = opts;

  const failedTriggers = evalResults.results.filter(
    (r) => r.should_trigger && !r.pass,
  );
  const falseTriggers = evalResults.results.filter(
    (r) => !r.should_trigger && !r.pass,
  );

  const trainScore = `${evalResults.summary.passed}/${evalResults.summary.total}`;
  const scoresSummary = testResults
    ? `Train: ${trainScore}, Test: ${testResults.summary.passed}/${testResults.summary.total}`
    : `Train: ${trainScore}`;

  let prompt = `You are optimizing a skill description for a Claude Code skill called "${skillName}". A "skill" is sort of like a prompt, but with progressive disclosure -- there's a title and description that Claude sees when deciding whether to use the skill, and then if it does use the skill, it reads the .md file which has lots more details and potentially links to other resources in the skill folder like helper files and scripts and additional documentation or examples.

The description appears in Claude's "available_skills" list. When a user sends a query, Claude decides whether to invoke the skill based solely on the title and on this description. Your goal is to write a description that triggers for relevant queries, and doesn't trigger for irrelevant ones.

Here's the current description:
<current_description>
"${currentDescription}"
</current_description>

Current scores (${scoresSummary}):
<scores_summary>
`;

  if (failedTriggers.length > 0) {
    prompt += "FAILED TO TRIGGER (should have triggered but didn't):\n";
    for (const r of failedTriggers) {
      prompt += `  - "${r.query}" (triggered ${r.triggers}/${r.runs} times)\n`;
    }
    prompt += "\n";
  }

  if (falseTriggers.length > 0) {
    prompt += "FALSE TRIGGERS (triggered but shouldn't have):\n";
    for (const r of falseTriggers) {
      prompt += `  - "${r.query}" (triggered ${r.triggers}/${r.runs} times)\n`;
    }
    prompt += "\n";
  }

  if (history.length > 0) {
    prompt +=
      "PREVIOUS ATTEMPTS (do NOT repeat these — try something structurally different):\n\n";
    for (const h of history) {
      const trainS = `${h.train_passed ?? h.passed ?? 0}/${h.train_total ?? h.total ?? 0}`;
      const testS =
        h.train_passed != null && h.test_passed != null
          ? `, test=${h.test_passed}/${h.test_total}`
          : "";
      prompt += `<attempt train=${trainS}${testS}>\n`;
      prompt += `Description: "${h.description}"\n`;
      if (h.results) {
        prompt += "Train results:\n";
        for (const r of h.results) {
          const status = r.pass ? "PASS" : "FAIL";
          prompt += `  [${status}] "${(r.query as string).slice(0, 80)}" (triggered ${r.triggers}/${r.runs})\n`;
        }
      }
      if (h.note) prompt += `Note: ${h.note}\n`;
      prompt += "</attempt>\n\n";
    }
  }

  prompt += `</scores_summary>

Skill content (for context on what the skill does):
<skill_content>
${skillContent}
</skill_content>

Based on the failures, write a new and improved description that is more likely to trigger correctly. When I say "based on the failures", it's a bit of a tricky line to walk because we don't want to overfit to the specific cases you're seeing. So what I DON'T want you to do is produce an ever-expanding list of specific queries that this skill should or shouldn't trigger for. Instead, try to generalize from the failures to broader categories of user intent and situations where this skill would be useful or not useful. The reason for this is twofold:

1. Avoid overfitting
2. The list might get loooong and it's injected into ALL queries and there might be a lot of skills, so we don't want to blow too much space on any given description.

Concretely, your description should not be more than about 100-200 words, even if that comes at the cost of accuracy. There is a hard limit of 1024 characters — descriptions over that will be truncated, so stay comfortably under it.

Here are some tips that we've found to work well in writing these descriptions:
- The skill should be phrased in the imperative -- "Use this skill for" rather than "this skill does"
- The skill description should focus on the user's intent, what they are trying to achieve, vs. the implementation details of how the skill works.
- The description competes with other skills for Claude's attention — make it distinctive and immediately recognizable.
- If you're getting lots of failures after repeated attempts, change things up. Try different sentence structures or wordings.

I'd encourage you to be creative and mix up the style in different iterations since you'll have multiple opportunities to try different approaches and we'll just grab the highest-scoring one at the end.

Please respond with only the new description text in <new_description> tags, nothing else.`;

  const text = await callClaude(prompt, model);

  const match = text.match(/<new_description>([\s\S]*?)<\/new_description>/);
  let description = match
    ? match[1].trim().replace(/^"|"$/g, "")
    : text.trim().replace(/^"|"$/g, "");

  const transcript: ImproveTranscript = {
    iteration,
    prompt,
    response: text,
    parsed_description: description,
    char_count: description.length,
    over_limit: description.length > 1024,
  };

  if (description.length > 1024) {
    const shortenPrompt = `${prompt}\n\n---\n\nA previous attempt produced this description, which at ${description.length} characters is over the 1024-character hard limit:\n\n"${description}"\n\nRewrite it to be under 1024 characters while keeping the most important trigger words and intent coverage. Respond with only the new description in <new_description> tags.`;
    const shortenText = await callClaude(shortenPrompt, model);
    const m2 = shortenText.match(
      /<new_description>([\s\S]*?)<\/new_description>/,
    );
    const shortened = m2
      ? m2[1].trim().replace(/^"|"$/g, "")
      : shortenText.trim().replace(/^"|"$/g, "");

    transcript.rewrite_prompt = shortenPrompt;
    transcript.rewrite_response = shortenText;
    transcript.rewrite_description = shortened;
    transcript.rewrite_char_count = shortened.length;
    description = shortened;
  }

  transcript.final_description = description;

  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, `improve_iter_${iteration ?? "unknown"}.json`),
      JSON.stringify(transcript, null, 2),
    );
  }

  return description;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "eval-results": { type: "string" },
      "skill-path": { type: "string" },
      history: { type: "string" },
      model: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!values["eval-results"] || !values["skill-path"] || !values.model) {
    console.error("Required: --eval-results, --skill-path, --model");
    process.exit(1);
  }

  const skillPath = resolve(values["skill-path"]);
  if (!existsSync(join(skillPath, "SKILL.md"))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const evalResults: EvalResults = JSON.parse(
    readFileSync(resolve(values["eval-results"]), "utf-8"),
  );
  const historyData: HistoryEntry[] = values.history
    ? JSON.parse(readFileSync(resolve(values.history), "utf-8"))
    : [];

  const { name, content } = parseSkillMd(skillPath);
  const currentDescription = evalResults.description || "";

  if (values.verbose) {
    console.error(`Current: ${currentDescription}`);
    console.error(
      `Score: ${evalResults.summary.passed}/${evalResults.summary.total}`,
    );
  }

  const newDescription = await improveDescription({
    skillName: name,
    skillContent: content,
    currentDescription,
    evalResults,
    history: historyData,
    model: values.model,
  });

  if (values.verbose) console.error(`Improved: ${newDescription}`);

  const output = {
    description: newDescription,
    history: [
      ...historyData,
      {
        description: currentDescription,
        passed: evalResults.summary.passed,
        failed: evalResults.summary.failed,
        total: evalResults.summary.total,
        results: evalResults.results,
      },
    ],
  };
  console.log(JSON.stringify(output, null, 2));
}
