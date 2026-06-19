// --- Types -----------------------------------------------------------------

export type LensName = "security" | "types" | "lint" | "dependencies";

export type Severity = "error" | "warning" | "info";

export type Source =
  | "semgrep"
  | "biome"
  | "eslint"
  | "tsc"
  | "svelte-check"
  | "npm-audit";

export type Finding = {
  file: string;
  line: number;
  end_line?: number;
  rule_id: string;
  message: string;
  /** 0–100. Filtered against `--min-confidence` before emission. */
  confidence: number;
  severity?: Severity;
  source: Source;
};

export type LensMeta = {
  /** True iff the tool was found and executed (even if it returned no findings). */
  ran: boolean;
  /** Short kebab-case reason when `ran=false`. Stable enum so consumers can match. */
  skipped_reason?: string;
  tool_version?: string;
  duration_ms: number;
};

export type AnalysisResult = {
  security: Finding[];
  types: Finding[];
  lint: Finding[];
  dependencies: Finding[];
  meta: {
    security: LensMeta;
    types: LensMeta;
    lint: LensMeta;
    dependencies: LensMeta;
    pr: number;
    min_confidence: number;
    duration_ms: number;
  };
};

// --- I/O wiring types ------------------------------------------------------

export type CmdResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};
export type SpawnRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<CmdResult>;
export type GhRunner = (argv: string[]) => Promise<CmdResult>;
export type WhichFn = (cmd: string) => string | null;

export type Deps = {
  spawn?: SpawnRunner;
  gh?: GhRunner;
  which?: WhichFn;
  readFile?: (p: string) => string | null;
  fileExists?: (p: string) => boolean;
  cwd?: string;
  now?: () => number;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
};

// --- CLI types -------------------------------------------------------------

export type Args = {
  pr: number;
  minConfidence: number;
  maxToolTimeoutSec: number;
};

// --- Lens types ------------------------------------------------------------

export type LensRun = (
  args: Args,
  deps: Required<
    Pick<
      Deps,
      "spawn" | "which" | "readFile" | "fileExists" | "cwd" | "now" | "writeErr"
    >
  >,
) => Promise<{ findings: Finding[]; meta: LensMeta }>;
