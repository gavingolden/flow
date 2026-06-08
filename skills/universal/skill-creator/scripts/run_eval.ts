import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { EvalItem, EvalResult } from "./utils.ts";
import { parseSkillMd } from "./utils.ts";

export function findProjectRoot(): string {
  let current = resolve(".");
  while (true) {
    if (existsSync(join(current, ".claude"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return resolve(".");
    current = parent;
  }
}

async function runSingleQuery(
  query: string,
  skillName: string,
  skillDescription: string,
  timeout: number,
  projectRoot: string,
  model?: string,
): Promise<boolean> {
  const uniqueId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const cleanName = `${skillName}-skill-${uniqueId}`;
  const commandsDir = join(projectRoot, ".claude", "commands");
  const commandFile = join(commandsDir, `${cleanName}.md`);

  try {
    mkdirSync(commandsDir, { recursive: true });

    const indentedDesc = skillDescription.split("\n").join("\n  ");
    writeFileSync(
      commandFile,
      `---\ndescription: |\n  ${indentedDesc}\n---\n\n# ${skillName}\n\nThis skill handles: ${skillDescription}\n`,
    );

    const cmd = [
      "claude",
      "-p",
      query,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (model) cmd.push("--model", model);

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"),
    );

    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectRoot,
      env,
    });

    let triggered = false;
    let pendingToolName: string | null = null;
    let accumulatedJson = "";

    const timeoutId = setTimeout(() => proc.kill(), timeout * 1000);

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx === -1) break;
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);

          if (!line) continue;
          let event: ClaudeStreamEvent;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "stream_event") {
            const se = event.event || {};
            const seType = se.type || "";

            if (seType === "content_block_start") {
              const cb = se.content_block || {};
              if (cb.type === "tool_use") {
                const toolName = cb.name || "";
                if (toolName === "Skill" || toolName === "Read") {
                  pendingToolName = toolName;
                  accumulatedJson = "";
                } else {
                  pendingToolName = null;
                  accumulatedJson = "";
                }
              }
            } else if (seType === "content_block_delta" && pendingToolName) {
              const delta = se.delta || {};
              if (delta.type === "input_json_delta") {
                accumulatedJson += delta.partial_json || "";
                if (accumulatedJson.includes(cleanName)) {
                  triggered = true;
                  break outer;
                }
              }
            } else if (
              seType === "content_block_stop" ||
              seType === "message_stop"
            ) {
              if (pendingToolName) {
                triggered = accumulatedJson.includes(cleanName);
                break outer;
              }
              if (seType === "message_stop") {
                triggered = false;
                break outer;
              }
            }
          } else if (event.type === "assistant") {
            const message = event.message || {};
            for (const item of message.content || []) {
              if (item.type !== "tool_use") continue;
              if (
                item.name === "Skill" &&
                (item.input?.skill || "").includes(cleanName)
              ) {
                triggered = true;
              } else if (
                item.name === "Read" &&
                (item.input?.file_path || "").includes(cleanName)
              ) {
                triggered = true;
              }
              break outer;
            }
          } else if (event.type === "result") {
            break outer;
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      if (proc.exitCode === null) {
        proc.kill();
        await proc.exited;
      }
    }

    return triggered;
  } finally {
    if (existsSync(commandFile)) unlinkSync(commandFile);
  }
}

interface ClaudeStreamEvent {
  type: string;
  event?: {
    type: string;
    content_block?: { type: string; name?: string };
    delta?: { type: string; partial_json?: string };
  };
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: { skill?: string; file_path?: string };
    }>;
  };
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const i = nextIdx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  return results;
}

export async function runEval(opts: {
  evalSet: EvalItem[];
  skillName: string;
  description: string;
  numWorkers: number;
  timeout: number;
  projectRoot: string;
  runsPerQuery?: number;
  triggerThreshold?: number;
  model?: string;
}): Promise<{
  skill_name: string;
  description: string;
  results: EvalResult[];
  summary: { total: number; passed: number; failed: number };
}> {
  const {
    evalSet,
    skillName,
    description,
    numWorkers,
    timeout,
    projectRoot,
    runsPerQuery = 1,
    triggerThreshold = 0.5,
    model,
  } = opts;

  interface TaskInfo {
    item: EvalItem;
    runIdx: number;
  }

  const tasks: (() => Promise<{ info: TaskInfo; result: boolean }>)[] = [];

  for (const item of evalSet) {
    for (let runIdx = 0; runIdx < runsPerQuery; runIdx++) {
      const info: TaskInfo = { item, runIdx };
      tasks.push(async () => {
        try {
          const result = await runSingleQuery(
            item.query,
            skillName,
            description,
            timeout,
            projectRoot,
            model,
          );
          return { info, result };
        } catch (e) {
          console.error(`Warning: query failed: ${e}`);
          return { info, result: false };
        }
      });
    }
  }

  const rawResults = await runWithConcurrency(tasks, numWorkers);

  const queryTriggers = new Map<string, boolean[]>();
  const queryItems = new Map<string, EvalItem>();

  for (const { info, result } of rawResults) {
    const q = info.item.query;
    queryItems.set(q, info.item);
    if (!queryTriggers.has(q)) queryTriggers.set(q, []);
    queryTriggers.get(q)!.push(result);
  }

  const results: EvalResult[] = [];
  for (const [query, triggers] of queryTriggers) {
    const item = queryItems.get(query)!;
    const triggerRate = triggers.filter(Boolean).length / triggers.length;
    const didPass = item.should_trigger
      ? triggerRate >= triggerThreshold
      : triggerRate < triggerThreshold;

    results.push({
      query,
      should_trigger: item.should_trigger,
      trigger_rate: triggerRate,
      triggers: triggers.filter(Boolean).length,
      runs: triggers.length,
      pass: didPass,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    skill_name: skillName,
    description,
    results,
    summary: { total: results.length, passed, failed: results.length - passed },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "eval-set": { type: "string" },
      "skill-path": { type: "string" },
      description: { type: "string" },
      "num-workers": { type: "string", default: "10" },
      timeout: { type: "string", default: "30" },
      "runs-per-query": { type: "string", default: "3" },
      "trigger-threshold": { type: "string", default: "0.5" },
      model: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!values["eval-set"] || !values["skill-path"]) {
    console.error("Required: --eval-set and --skill-path");
    process.exit(1);
  }

  const skillPath = resolve(values["skill-path"]);
  if (!existsSync(join(skillPath, "SKILL.md"))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const evalSet: EvalItem[] = JSON.parse(
    readFileSync(resolve(values["eval-set"]), "utf-8"),
  );
  const { name, description: origDesc } = parseSkillMd(skillPath);
  const description = values.description || origDesc;
  const projectRoot = findProjectRoot();

  if (values.verbose) console.error(`Evaluating: ${description}`);

  const output = await runEval({
    evalSet,
    skillName: name,
    description,
    numWorkers: parseInt(values["num-workers"]!),
    timeout: parseInt(values.timeout!),
    projectRoot,
    runsPerQuery: parseInt(values["runs-per-query"]!),
    triggerThreshold: parseFloat(values["trigger-threshold"]!),
    model: values.model,
  });

  if (values.verbose) {
    const s = output.summary;
    console.error(`Results: ${s.passed}/${s.total} passed`);
    for (const r of output.results) {
      const status = r.pass ? "PASS" : "FAIL";
      console.error(
        `  [${status}] rate=${r.triggers}/${r.runs} expected=${r.should_trigger}: ${r.query.slice(0, 70)}`,
      );
    }
  }

  console.log(JSON.stringify(output, null, 2));
}
