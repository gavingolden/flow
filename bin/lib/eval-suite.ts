/**
 * Declarative suite/scenario types plus a tolerant loader/validator for
 * `bin/flow-eval.ts`'s scenario suites under `evals/<suite>/`. Follows
 * `bin/lib/model-bench-schema.ts`'s `ValidationOk<T>`/`ValidationErr`/
 * `ValidationResult<T>` shape — a single `reason` string, never an
 * `errors: string[]` array.
 *
 * Internal import only. Deliberately NOT added to
 * `bin/lib/sources.ts`'s `VALIDATOR_MODULES` allowlist — no pipeline skill
 * invokes this by bare name; `flow-eval` itself is maintainer-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isValidSlug } from "./slug";
import type { CheckpointSite } from "./checkpoint-freshness";

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function isValidationErr(v: unknown): v is ValidationErr {
  return isPlainObject(v) && v.ok === false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

export type GraderKind =
  | "structured"
  | "json-file"
  | "file"
  | "command"
  | "git-clean"
  | "metric";

const GRADER_KINDS: ReadonlySet<string> = new Set([
  "structured",
  "json-file",
  "file",
  "command",
  "git-clean",
  "metric",
]);

export type Matcher = {
  equals?: unknown;
  oneOf?: unknown[];
  contains?: string;
  matches?: string;
  notMatches?: string;
  exists?: boolean;
};

const MATCHER_KEYS = [
  "equals",
  "oneOf",
  "contains",
  "matches",
  "notMatches",
  "exists",
] as const;

function matcherKeyCount(o: Record<string, unknown>): number {
  return MATCHER_KEYS.filter((k) => o[k] !== undefined).length;
}

export type GraderSpec = Matcher & {
  id: string;
  kind: GraderKind;
  gate?: boolean;
  path?: string;
  file?: string;
  argv?: string[];
  cwd?: string;
  expectExit?: number;
  allow?: string[];
  source?: string;
  direction?: "lower" | "higher";
  max?: number;
  min?: number;
};

export type FixtureSpec = {
  repo?: string;
  overlay?: string;
  linkNodeModules?: boolean;
  state?: string;
  checkpoint?: { body: string; site: CheckpointSite; armed: boolean };
  shims?: string[];
};

export type ScenarioSpec = {
  id: string;
  title: string;
  provenance: string;
  prompt: string;
  preload?: string[];
  promptSeed?: "resume" | "terminal";
  fixture?: FixtureSpec;
  env?: { flowSlug?: boolean };
  allowedTools?: string[];
  model?: string;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  runs?: number;
  resultSchema?: string;
  graders: GraderSpec[];
};

export type SuiteSpec = {
  schemaVersion: 1;
  id: string;
  candidate: string;
  description: string;
  scenarios: string[];
  defaults?: Partial<
    Pick<
      ScenarioSpec,
      "runs" | "maxBudgetUsd" | "timeoutSec" | "allowedTools" | "model"
    >
  >;
};

export type ResolvedScenario = Required<
  Pick<ScenarioSpec, "runs" | "maxBudgetUsd" | "timeoutSec" | "allowedTools">
> &
  ScenarioSpec & { dir: string };

export type LoadedSuite = {
  spec: SuiteSpec;
  dir: string;
  scenarios: ResolvedScenario[];
};

export const SCENARIO_DEFAULTS = {
  runs: 2,
  maxBudgetUsd: 4,
  timeoutSec: 900,
  allowedTools: [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "Skill",
    "Task",
    "Agent",
    "ToolSearch",
  ],
} as const;

const CHECKPOINT_SITE_SET: ReadonlySet<string> = new Set([
  "manual",
  "plan-review",
  "plan-approval",
  "gate",
  "terminal",
]);

/**
 * `eval-<suite>-<scenario>-r<run>`, lowercased, truncating only the
 * scenario segment to fit `isValidSlug`'s 60-char cap — the `-r<n>` run
 * suffix is always preserved verbatim so runs of the same scenario never
 * collide once truncated. Best-effort: a `suiteId` alone too long to leave
 * room for a scenario segment produces a string that will itself fail
 * `isValidSlug` — callers (`loadSuite` here, `materializeFixture` in
 * `./eval-fixture`) must check the result, not assume it always validates.
 */
export function evalSlug(
  suiteId: string,
  scenarioId: string,
  run: number,
): string {
  const prefix = `eval-${suiteId}-`.toLowerCase();
  const suffix = `-r${run}`;
  const budget = 60 - prefix.length - suffix.length;
  const scenario = scenarioId.toLowerCase();
  const truncated =
    budget > 0 ? scenario.slice(0, budget).replace(/-+$/, "") : "";
  return `${prefix}${truncated}${suffix}`.replace(/-{2,}/g, "-");
}

function validateGraderSpec(
  o: unknown,
  index: number,
): ValidationErr | GraderSpec {
  const at = `graders[${index}]`;
  if (!isPlainObject(o)) return err("grader must be a JSON object", at);
  if (!isNonEmptyString(o.id)) {
    return err("grader 'id' must be a non-empty string", at);
  }
  if (!isString(o.kind) || !GRADER_KINDS.has(o.kind)) {
    return err(
      `grader 'kind' must be one of structured|json-file|file|command|git-clean|metric`,
      at,
    );
  }
  const kind = o.kind as GraderKind;
  if (o.gate !== undefined && !isBoolean(o.gate)) {
    return err("grader 'gate' must be a boolean", at);
  }
  const matcherCount = matcherKeyCount(o);

  if (kind === "structured" || kind === "json-file") {
    if (!isNonEmptyString(o.path)) {
      return err(`grader kind '${kind}' requires a non-empty 'path'`, at);
    }
    if (kind === "json-file" && !isNonEmptyString(o.file)) {
      return err(`grader kind 'json-file' requires a non-empty 'file'`, at);
    }
    if (matcherCount !== 1) {
      return err(
        `grader kind '${kind}' requires exactly one matcher key (${MATCHER_KEYS.join("|")})`,
        at,
      );
    }
  } else if (kind === "file") {
    if (!isNonEmptyString(o.file)) {
      return err("grader kind 'file' requires a non-empty 'file'", at);
    }
    if (matcherCount !== 1) {
      return err(
        `grader kind 'file' requires exactly one matcher key (${MATCHER_KEYS.join("|")})`,
        at,
      );
    }
  } else if (kind === "command") {
    if (!isNonEmptyStringArray(o.argv)) {
      return err("grader kind 'command' requires a non-empty 'argv' array", at);
    }
    if (o.cwd !== undefined && !isString(o.cwd)) {
      return err("grader 'cwd' must be a string", at);
    }
    if (o.expectExit !== undefined && !isNumber(o.expectExit)) {
      return err("grader 'expectExit' must be a number", at);
    }
  } else if (kind === "git-clean") {
    if (o.cwd !== undefined && !isString(o.cwd)) {
      return err("grader 'cwd' must be a string", at);
    }
    if (o.allow !== undefined && !isStringArray(o.allow)) {
      return err("grader 'allow' must be a string array", at);
    }
  } else if (kind === "metric") {
    if (!isNonEmptyString(o.source)) {
      return err("grader kind 'metric' requires a non-empty 'source'", at);
    }
    if (o.direction !== "lower" && o.direction !== "higher") {
      return err(
        "grader kind 'metric' requires 'direction' to be 'lower' or 'higher'",
        at,
      );
    }
    if (o.max !== undefined && !isNumber(o.max)) {
      return err("grader 'max' must be a number", at);
    }
    if (o.min !== undefined && !isNumber(o.min)) {
      return err("grader 'min' must be a number", at);
    }
  }

  return o as GraderSpec;
}

export function validateScenarioSpec(
  o: unknown,
): ValidationResult<ScenarioSpec> {
  if (!isPlainObject(o)) return err("scenario must be a JSON object");
  if (!isNonEmptyString(o.id)) return err("'id' must be a non-empty string");
  if (!isNonEmptyString(o.title))
    return err("'title' must be a non-empty string");
  if (!isNonEmptyString(o.provenance)) {
    return err("'provenance' must be a non-empty string");
  }
  if (!isNonEmptyString(o.prompt)) {
    return err("'prompt' must be a non-empty string (a file path)");
  }
  if (o.preload !== undefined && !isStringArray(o.preload)) {
    return err("'preload' must be a string array");
  }
  if (
    o.promptSeed !== undefined &&
    o.promptSeed !== "resume" &&
    o.promptSeed !== "terminal"
  ) {
    return err("'promptSeed' must be 'resume' or 'terminal'");
  }
  if (o.fixture !== undefined) {
    if (!isPlainObject(o.fixture)) return err("'fixture' must be an object");
    const f = o.fixture;
    if (f.repo !== undefined && !isString(f.repo)) {
      return err("'fixture.repo' must be a string");
    }
    if (f.overlay !== undefined && !isString(f.overlay)) {
      return err("'fixture.overlay' must be a string");
    }
    if (f.linkNodeModules !== undefined && !isBoolean(f.linkNodeModules)) {
      return err("'fixture.linkNodeModules' must be a boolean");
    }
    if (f.state !== undefined && !isString(f.state)) {
      return err("'fixture.state' must be a string");
    }
    if (f.shims !== undefined && !isStringArray(f.shims)) {
      return err("'fixture.shims' must be a string array");
    }
    if (f.checkpoint !== undefined) {
      if (!isPlainObject(f.checkpoint)) {
        return err("'fixture.checkpoint' must be an object");
      }
      const c = f.checkpoint;
      if (!isNonEmptyString(c.body)) {
        return err("'fixture.checkpoint.body' must be a non-empty string");
      }
      if (!isString(c.site) || !CHECKPOINT_SITE_SET.has(c.site)) {
        return err("'fixture.checkpoint.site' must be a valid CheckpointSite");
      }
      if (!isBoolean(c.armed)) {
        return err("'fixture.checkpoint.armed' must be a boolean");
      }
    }
  }
  if (o.env !== undefined) {
    if (!isPlainObject(o.env)) return err("'env' must be an object");
    if (o.env.flowSlug !== undefined && !isBoolean(o.env.flowSlug)) {
      return err("'env.flowSlug' must be a boolean");
    }
  }
  if (o.allowedTools !== undefined && !isStringArray(o.allowedTools)) {
    return err("'allowedTools' must be a string array");
  }
  if (o.model !== undefined && !isString(o.model)) {
    return err("'model' must be a string");
  }
  if (o.maxBudgetUsd !== undefined && !isNumber(o.maxBudgetUsd)) {
    return err("'maxBudgetUsd' must be a number");
  }
  if (o.timeoutSec !== undefined && !isNumber(o.timeoutSec)) {
    return err("'timeoutSec' must be a number");
  }
  if (o.runs !== undefined && !isNumber(o.runs)) {
    return err("'runs' must be a number");
  }
  if (o.resultSchema !== undefined && !isString(o.resultSchema)) {
    return err("'resultSchema' must be a string");
  }
  if (!Array.isArray(o.graders) || o.graders.length === 0) {
    return err("'graders' must be a non-empty array");
  }
  const seenGraderIds = new Set<string>();
  for (let i = 0; i < o.graders.length; i++) {
    const result = validateGraderSpec(o.graders[i], i);
    if (isValidationErr(result)) return result;
    if (seenGraderIds.has(result.id)) {
      return err(`duplicate grader id '${result.id}'`, `graders[${i}]`);
    }
    seenGraderIds.add(result.id);
  }
  return { ok: true, value: o as unknown as ScenarioSpec };
}

export function validateSuiteSpec(o: unknown): ValidationResult<SuiteSpec> {
  if (!isPlainObject(o)) return err("suite must be a JSON object");
  if (o.schemaVersion !== 1) {
    return err("'schemaVersion' must be 1");
  }
  if (!isNonEmptyString(o.id)) return err("'id' must be a non-empty string");
  if (!isNonEmptyString(o.candidate)) {
    return err("'candidate' must be a non-empty string");
  }
  if (!isNonEmptyString(o.description)) {
    return err("'description' must be a non-empty string");
  }
  if (!isNonEmptyStringArray(o.scenarios)) {
    return err("'scenarios' must be a non-empty string array");
  }
  if (o.defaults !== undefined) {
    if (!isPlainObject(o.defaults)) return err("'defaults' must be an object");
    const d = o.defaults;
    if (d.runs !== undefined && !isNumber(d.runs)) {
      return err("'defaults.runs' must be a number");
    }
    if (d.maxBudgetUsd !== undefined && !isNumber(d.maxBudgetUsd)) {
      return err("'defaults.maxBudgetUsd' must be a number");
    }
    if (d.timeoutSec !== undefined && !isNumber(d.timeoutSec)) {
      return err("'defaults.timeoutSec' must be a number");
    }
    if (d.allowedTools !== undefined && !isStringArray(d.allowedTools)) {
      return err("'defaults.allowedTools' must be a string array");
    }
    if (d.model !== undefined && !isString(d.model)) {
      return err("'defaults.model' must be a string");
    }
  }
  return { ok: true, value: o as unknown as SuiteSpec };
}

export type LoadSuiteDeps = {
  readFile: (p: string) => string | null;
  exists: (p: string) => boolean;
};

const defaultDeps: LoadSuiteDeps = {
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  exists: (p) => {
    try {
      fs.statSync(p);
      return true;
    } catch {
      return false;
    }
  },
};

function resolveScenario(
  suiteId: string,
  scenarioDir: string,
  scenarioId: string,
  deps: LoadSuiteDeps,
  suiteDefaults: SuiteSpec["defaults"],
): ValidationResult<ResolvedScenario> {
  const casePath = path.join(scenarioDir, "case.json");
  const raw = deps.readFile(casePath);
  if (raw === null) {
    return err(`missing case.json for scenario '${scenarioId}'`, casePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(
      `case.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      casePath,
    );
  }
  const validated = validateScenarioSpec(parsed);
  if (!validated.ok) return validated;
  const spec = validated.value;

  if (spec.id !== scenarioId) {
    return err(
      `case.json 'id' ('${spec.id}') must match its directory name ('${scenarioId}')`,
      casePath,
    );
  }

  const runs = spec.runs ?? suiteDefaults?.runs ?? SCENARIO_DEFAULTS.runs;
  const maxBudgetUsd =
    spec.maxBudgetUsd ??
    suiteDefaults?.maxBudgetUsd ??
    SCENARIO_DEFAULTS.maxBudgetUsd;
  const timeoutSec =
    spec.timeoutSec ??
    suiteDefaults?.timeoutSec ??
    SCENARIO_DEFAULTS.timeoutSec;
  const allowedTools = spec.allowedTools ??
    suiteDefaults?.allowedTools ?? [...SCENARIO_DEFAULTS.allowedTools];
  const model = spec.model ?? suiteDefaults?.model;

  // Every file the scenario references is resolved relative to the
  // scenario dir and must exist — `shims` may climb out via `../` (shared
  // `evals/_shims/gh`), which is intentional.
  const referenced: Array<{ label: string; rel: string }> = [
    { label: "prompt", rel: spec.prompt },
  ];
  if (spec.resultSchema)
    referenced.push({ label: "resultSchema", rel: spec.resultSchema });
  if (spec.preload) {
    for (const p of spec.preload) referenced.push({ label: "preload", rel: p });
  }
  if (spec.fixture?.repo)
    referenced.push({ label: "fixture.repo", rel: spec.fixture.repo });
  if (spec.fixture?.overlay) {
    referenced.push({ label: "fixture.overlay", rel: spec.fixture.overlay });
  }
  if (spec.fixture?.state)
    referenced.push({ label: "fixture.state", rel: spec.fixture.state });
  if (spec.fixture?.checkpoint?.body) {
    referenced.push({
      label: "fixture.checkpoint.body",
      rel: spec.fixture.checkpoint.body,
    });
  }
  if (spec.fixture?.shims) {
    for (const s of spec.fixture.shims)
      referenced.push({ label: "fixture.shims", rel: s });
  }

  for (const { label, rel } of referenced) {
    const abs = path.join(scenarioDir, rel);
    if (!deps.exists(abs)) {
      return err(
        `'${label}' references a path that does not exist: ${rel}`,
        abs,
      );
    }
  }

  const slug = evalSlug(suiteId, spec.id, 1);
  if (!isValidSlug(slug)) {
    return err(
      `scenario '${spec.id}' produces an eval slug ('${slug}') that exceeds isValidSlug's cap`,
      casePath,
    );
  }

  return {
    ok: true,
    value: {
      ...spec,
      runs,
      maxBudgetUsd,
      timeoutSec,
      allowedTools,
      model,
      dir: scenarioDir,
    },
  };
}

export function loadSuite(
  dir: string,
  deps: LoadSuiteDeps = defaultDeps,
): ValidationResult<LoadedSuite> {
  const suitePath = path.join(dir, "suite.json");
  const raw = deps.readFile(suitePath);
  if (raw === null) {
    return err(`missing suite.json`, suitePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(
      `suite.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      suitePath,
    );
  }
  const validated = validateSuiteSpec(parsed);
  if (!validated.ok) return validated;
  const spec = validated.value;

  const scenarios: ResolvedScenario[] = [];
  for (const scenarioId of spec.scenarios) {
    const scenarioDir = path.join(dir, scenarioId);
    const resolved = resolveScenario(
      spec.id,
      scenarioDir,
      scenarioId,
      deps,
      spec.defaults,
    );
    if (!resolved.ok) return resolved;
    scenarios.push(resolved.value);
  }

  return { ok: true, value: { spec, dir, scenarios } };
}
