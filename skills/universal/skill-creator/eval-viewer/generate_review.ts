import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { GradingData } from "../scripts/utils.ts";

const METADATA_FILES = new Set(["transcript.md", "user_notes.md", "metrics.json"]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".sh",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".r",
  ".toml",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

const MIME_OVERRIDES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_OVERRIDES[ext] ?? "application/octet-stream";
}

interface RunData {
  id: string;
  prompt: string;
  eval_id: number | null;
  outputs: FileData[];
  grading: GradingData | null;
}

interface FileData {
  name: string;
  type: string;
  content?: string;
  mime?: string;
  data_uri?: string;
  data_b64?: string;
}

function embedFile(filePath: string): FileData {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = getMimeType(filePath);

  if (TEXT_EXTENSIONS.has(ext)) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      content = "(Error reading file)";
    }
    return { name, type: "text", content };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const raw = readFileSync(filePath);
      const b64 = raw.toString("base64");
      return { name, type: "image", mime, data_uri: `data:${mime};base64,${b64}` };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  if (ext === ".pdf") {
    try {
      const raw = readFileSync(filePath);
      const b64 = raw.toString("base64");
      return { name, type: "pdf", data_uri: `data:${mime};base64,${b64}` };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  if (ext === ".xlsx") {
    try {
      const raw = readFileSync(filePath);
      return { name, type: "xlsx", data_b64: raw.toString("base64") };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  // Binary / unknown
  try {
    const raw = readFileSync(filePath);
    const b64 = raw.toString("base64");
    return { name, type: "binary", mime, data_uri: `data:${mime};base64,${b64}` };
  } catch {
    return { name, type: "error", content: "(Error reading file)" };
  }
}

function findRunsRecursive(root: string, current: string, runs: RunData[]): void {
  if (!statSync(current).isDirectory()) return;

  const outputsDir = join(current, "outputs");
  if (existsSync(outputsDir) && statSync(outputsDir).isDirectory()) {
    const run = buildRun(root, current);
    if (run) runs.push(run);
    return;
  }

  const skip = new Set(["node_modules", ".git", "__pycache__", "skill", "inputs"]);
  for (const child of readdirSync(current).sort()) {
    const childPath = join(current, child);
    if (statSync(childPath).isDirectory() && !skip.has(child)) {
      findRunsRecursive(root, childPath, runs);
    }
  }
}

function findRuns(workspace: string): RunData[] {
  const runs: RunData[] = [];
  findRunsRecursive(workspace, workspace, runs);
  runs.sort((a, b) => {
    const ea = a.eval_id ?? Infinity;
    const eb = b.eval_id ?? Infinity;
    if (ea !== eb) return ea - eb;
    return a.id.localeCompare(b.id);
  });
  return runs;
}

function buildRun(root: string, runDir: string): RunData | null {
  let prompt = "";
  let evalId: number | null = null;

  // Try eval_metadata.json
  for (const candidate of [
    join(runDir, "eval_metadata.json"),
    join(dirname(runDir), "eval_metadata.json"),
  ]) {
    if (existsSync(candidate)) {
      try {
        const metadata = JSON.parse(readFileSync(candidate, "utf-8"));
        prompt = metadata.prompt || "";
        evalId = metadata.eval_id ?? null;
      } catch {
        // ignore
      }
      if (prompt) break;
    }
  }

  // Fall back to transcript.md
  if (!prompt) {
    for (const candidate of [
      join(runDir, "transcript.md"),
      join(runDir, "outputs", "transcript.md"),
    ]) {
      if (existsSync(candidate)) {
        try {
          const text = readFileSync(candidate, "utf-8");
          const match = text.match(/## Eval Prompt\n\n([\s\S]*?)(?=\n##|$)/);
          if (match) prompt = match[1].trim();
        } catch {
          // ignore
        }
        if (prompt) break;
      }
    }
  }

  if (!prompt) prompt = "(No prompt found)";

  const runId = relative(root, runDir).replace(/[/\\]/g, "-");

  // Collect output files
  const outputsDir = join(runDir, "outputs");
  const outputFiles: FileData[] = [];
  if (existsSync(outputsDir) && statSync(outputsDir).isDirectory()) {
    for (const f of readdirSync(outputsDir).sort()) {
      const fPath = join(outputsDir, f);
      if (statSync(fPath).isFile() && !METADATA_FILES.has(f)) {
        outputFiles.push(embedFile(fPath));
      }
    }
  }

  // Load grading
  let grading: GradingData | null = null;
  for (const candidate of [join(runDir, "grading.json"), join(dirname(runDir), "grading.json")]) {
    if (existsSync(candidate)) {
      try {
        grading = JSON.parse(readFileSync(candidate, "utf-8"));
      } catch {
        // ignore
      }
      if (grading) break;
    }
  }

  return { id: runId, prompt, eval_id: evalId, outputs: outputFiles, grading };
}

function loadPreviousIteration(
  workspace: string,
): Record<string, { feedback: string; outputs: FileData[] }> {
  const result: Record<string, { feedback: string; outputs: FileData[] }> = {};

  const feedbackMap: Record<string, string> = {};
  const feedbackPath = join(workspace, "feedback.json");
  if (existsSync(feedbackPath)) {
    try {
      const data = JSON.parse(readFileSync(feedbackPath, "utf-8"));
      for (const r of data.reviews || []) {
        if (r.run_id && r.feedback?.trim()) {
          feedbackMap[r.run_id] = r.feedback;
        }
      }
    } catch {
      // ignore
    }
  }

  const prevRuns = findRuns(workspace);
  for (const run of prevRuns) {
    result[run.id] = {
      feedback: feedbackMap[run.id] || "",
      outputs: run.outputs || [],
    };
  }

  for (const [runId, fb] of Object.entries(feedbackMap)) {
    if (!(runId in result)) {
      result[runId] = { feedback: fb, outputs: [] };
    }
  }

  return result;
}

function generateViewerHtml(
  runs: RunData[],
  skillName: string,
  previous?: Record<string, { feedback: string; outputs: FileData[] }>,
  benchmark?: Record<string, unknown> | null,
): string {
  const templatePath = join(dirname(import.meta.path.replace("file://", "")), "viewer.html");
  const template = readFileSync(templatePath, "utf-8");

  const previousFeedback: Record<string, string> = {};
  const previousOutputs: Record<string, FileData[]> = {};
  if (previous) {
    for (const [runId, data] of Object.entries(previous)) {
      if (data.feedback) previousFeedback[runId] = data.feedback;
      if (data.outputs?.length) previousOutputs[runId] = data.outputs;
    }
  }

  const embedded: {
    skill_name: string;
    runs: RunData[];
    previous_feedback: Record<string, string>;
    previous_outputs: Record<string, FileData[]>;
    benchmark?: Record<string, unknown>;
  } = {
    skill_name: skillName,
    runs,
    previous_feedback: previousFeedback,
    previous_outputs: previousOutputs,
  };
  if (benchmark) embedded.benchmark = benchmark;

  return template.replace(
    "/*__EMBEDDED_DATA__*/",
    `const EMBEDDED_DATA = ${JSON.stringify(embedded)};`,
  );
}

function killPort(port: number): void {
  try {
    const proc = Bun.spawnSync(["lsof", "-ti", `:${port}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const pids = new TextDecoder().decode(proc.stdout).trim().split("\n");
    for (const pid of pids) {
      if (pid.trim()) {
        try {
          process.kill(parseInt(pid.trim()), "SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    if (pids.some((p) => p.trim())) {
      Bun.sleepSync(500);
    }
  } catch {
    // ignore
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: "3117" },
      "skill-name": { type: "string", short: "n" },
      "previous-workspace": { type: "string" },
      benchmark: { type: "string" },
      static: { type: "string", short: "s" },
    },
    allowPositionals: true,
  });

  const workspacePath = positionals[0];
  if (!workspacePath) {
    console.error(
      "Usage: bun run generate_review.ts <workspace-path> [--port PORT] [--skill-name NAME]",
    );
    process.exit(1);
  }

  const workspace = resolve(workspacePath);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    console.error(`Error: ${workspace} is not a directory`);
    process.exit(1);
  }

  const runs = findRuns(workspace);
  if (runs.length === 0) {
    console.error(`No runs found in ${workspace}`);
    process.exit(1);
  }

  const skillName = values["skill-name"] || basename(workspace).replace("-workspace", "");
  const feedbackPath = join(workspace, "feedback.json");

  let previous: Record<string, { feedback: string; outputs: FileData[] }> = {};
  if (values["previous-workspace"]) {
    previous = loadPreviousIteration(resolve(values["previous-workspace"]));
  }

  let benchmark: Record<string, unknown> | null = null;
  if (values.benchmark) {
    const benchmarkPath = resolve(values.benchmark);
    if (existsSync(benchmarkPath)) {
      try {
        benchmark = JSON.parse(readFileSync(benchmarkPath, "utf-8"));
      } catch {
        // ignore
      }
    }
  }

  // Static export mode
  if (values.static) {
    const outputPath = resolve(values.static);
    const html = generateViewerHtml(runs, skillName, previous, benchmark);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html);
    console.log(`\n  Static viewer written to: ${outputPath}\n`);
    process.exit(0);
  }

  // Server mode
  const port = parseInt(values.port!);
  killPort(port);

  const benchmarkPath = values.benchmark ? resolve(values.benchmark) : null;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        // Regenerate on each request to pick up new outputs
        const latestRuns = findRuns(workspace);
        let latestBenchmark = benchmark;
        if (benchmarkPath && existsSync(benchmarkPath)) {
          try {
            latestBenchmark = JSON.parse(readFileSync(benchmarkPath, "utf-8"));
          } catch {
            // ignore
          }
        }
        const html = generateViewerHtml(latestRuns, skillName, previous, latestBenchmark);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/feedback") {
        const data = existsSync(feedbackPath) ? readFileSync(feedbackPath, "utf-8") : "{}";
        return new Response(data, {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/feedback") {
        return req.json().then((data: { reviews?: unknown[] }) => {
          if (!data?.reviews) {
            return new Response(JSON.stringify({ error: "Expected JSON with 'reviews' key" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
          writeFileSync(feedbackPath, JSON.stringify(data, null, 2) + "\n");
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://localhost:${server.port}`;
  console.log(`\n  Eval Viewer`);
  console.log(`  ${"─".repeat(35)}`);
  console.log(`  URL:       ${url}`);
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Feedback:  ${feedbackPath}`);
  if (Object.keys(previous).length > 0) {
    console.log(
      `  Previous:  ${values["previous-workspace"]} (${Object.keys(previous).length} runs)`,
    );
  }
  if (benchmarkPath) {
    console.log(`  Benchmark: ${benchmarkPath}`);
  }
  console.log(`\n  Press Ctrl+C to stop.\n`);

  Bun.spawn(["open", url]);
}
