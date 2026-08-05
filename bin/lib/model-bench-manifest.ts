/**
 * Pure manifest-building, blinding, and classification logic for
 * `flow-model-bench`. Split out of `bin/flow-model-bench.ts` to keep that
 * file under the target line budget — same non-PATH-bound precedent as
 * `bin/lib/model-bench-schema.ts` (an internal import of flow-model-bench
 * only, deliberately not added to `bin/lib/sources.ts`'s VALIDATOR_MODULES,
 * since discoverHelpers never globs into bin/lib/ in the first place).
 */

import { join } from "node:path";
import type { ManifestEntry as FanoutManifestEntry } from "../flow-delegate-fanout";
import {
  validateCase,
  type BenchArm,
  type BenchCase,
  type BenchResult,
} from "./model-bench-schema";

const DEFAULT_REPEATS = 1;

export type ManifestEntry = {
  caseId: string;
  arm: BenchArm;
  model: string;
  repeat: number;
  warmup: boolean;
  size?: number;
};

// One entry per (case, arm, model, repeat), PLUS one warm-up entry per
// (case, arm, model[, size]) flagged warmup:true — the scorer discards
// every warmup:true attempt. A schemaAb:false case yields a single 'n/a'
// arm; schemaAb:true yields both 'schema' and 'free-form'. A case carrying
// `sizes` yields one slot per size.
export function buildManifest(
  cases: BenchCase[],
  models: string[],
  repeatsOverride?: number,
): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const c of cases) {
    const arms: BenchArm[] =
      c.schemaAb === true ? ["schema", "free-form"] : ["n/a"];
    const sizes: Array<number | undefined> =
      c.sizes && c.sizes.length > 0 ? c.sizes : [undefined];
    const repeats = repeatsOverride ?? c.repeats ?? DEFAULT_REPEATS;
    for (const model of models) {
      for (const arm of arms) {
        for (const size of sizes) {
          entries.push({
            caseId: c.id,
            arm,
            model,
            repeat: -1,
            warmup: true,
            size,
          });
          for (let repeat = 0; repeat < repeats; repeat++) {
            entries.push({
              caseId: c.id,
              arm,
              model,
              repeat,
              warmup: false,
              size,
            });
          }
        }
      }
    }
  }
  return entries;
}

// n/a-arm entries always pass through unfiltered — --arms only narrows the
// schema-A/B slots, never the cases that have no A/B to narrow.
export function filterArms(
  entries: ManifestEntry[],
  arms?: BenchArm[],
): ManifestEntry[] {
  if (!arms || arms.length === 0) return entries;
  const allowed = new Set(arms);
  return entries.filter((e) => e.arm === "n/a" || allowed.has(e.arm));
}

export type BlindedOutput = {
  id: string;
  caseId: string;
  arm: BenchArm;
  text: string;
};

// NO model string may appear anywhere in `packet` — the model identity lives
// only in `key`, keyed by the same opaque id.
export function blind(results: BenchResult[]): {
  packet: BlindedOutput[];
  key: Record<string, string>;
} {
  const packet: BlindedOutput[] = [];
  const key: Record<string, string> = {};
  results.forEach((r, i) => {
    const id = `r${i + 1}`;
    packet.push({ id, caseId: r.caseId, arm: r.arm, text: r.response ?? "" });
    key[id] = r.model;
  });
  return { packet, key };
}

// Pure classifier for the delegate-bin preflight probe: a deliberately
// invalid --output-format value must fail with a usage error that NAMES the
// flag (exit 2, message mentions "--output-format") and is NOT an
// "unknown flag" error — the latter means the resolved binary predates the
// structured-output flags entirely.
export function classifyPreflight(
  exitCode: number,
  stderr: string,
  delegateBin: string,
): { ok: boolean; message: string } {
  if (
    exitCode === 2 &&
    /--output-format/.test(stderr) &&
    !/unknown flag/i.test(stderr)
  ) {
    return { ok: true, message: "" };
  }
  const reason = /unknown flag/i.test(stderr)
    ? "rejected --output-format as an unknown flag"
    : `did not fail with the expected usage error (exit ${exitCode}: ${stderr.trim() || "<empty stderr>"})`;
  return {
    ok: false,
    message: `resolved delegate-bin ${delegateBin} is stale or incompatible — ${reason}. Pass --delegate-bin pointing at a worktree flow-delegate.ts that supports --output-format/--json-schema/--structured-fallback.`,
  };
}

// DelegateEnvelope carries only a skipReason STRING, never raw stderr, so
// classification is pattern-based on that string. "agy-error" (agy's
// generic catch-all nonzero-exit bucket) is deliberately excluded by
// default — it covers a genuine model/parse failure as often as a
// transient blip, and a false-positive retry there would silently
// double-spend the call budget on a failure retrying can never fix.
// "not authenticated" is treated as an auth blip (transport-class); "not
// found" is a permanent local condition (agy isn't installed) and must
// never be retried.
export function isTransportSkip(skipReason: string | undefined): boolean {
  if (!skipReason) return false;
  return /timeout|5\d\d|rate.?limit|not authenticated/i.test(skipReason);
}

export function resolveMaxCalls(
  manifestLength: number,
  requested: number | undefined,
  progress: (line: string) => void,
): number {
  if (requested === undefined) return manifestLength;
  if (requested < manifestLength) {
    progress(
      `flow-model-bench: --max-calls ${requested} truncates the ${manifestLength}-entry manifest — dropping the last ${manifestLength - requested} entries deliberately\n`,
    );
  }
  return requested;
}

function entryId(e: ManifestEntry): string {
  const parts = [
    e.caseId,
    // The "n/a" arm literal carries a slash — sanitize every part the same
    // way so a slot id can never smuggle a path separator into a filename.
    e.arm.replace(/[^A-Za-z0-9._-]+/g, "-"),
    e.model.replace(/[^A-Za-z0-9._-]+/g, "-"),
    e.warmup ? "warmup" : `r${e.repeat}`,
  ];
  if (e.size !== undefined) parts.push(`s${e.size}`);
  return parts.join("--");
}

function composePrompt(
  c: BenchCase,
  fixturesDir: string,
  size: number | undefined,
  readFile: (p: string) => string,
): string {
  const caseDir = join(fixturesDir, c.id);
  const promptText = readFile(join(caseDir, c.promptFile));
  const inputText = c.inputFiles
    .map((f) => `\n\n### ${f}\n\n${readFile(join(caseDir, f))}`)
    .join("");
  const truncated = size !== undefined ? inputText.slice(0, size) : inputText;
  return `${promptText}${truncated}`;
}

// Materializes each manifest slot's prompt (with size head-truncation
// applied) and maps it onto the fanout's own ManifestEntry shape: the
// 'schema' arm sets wire-level jsonSchema, the 'free-form' arm sets the
// local structuredFallback — both pointing at the SAME schema file.
export function toFanoutEntries(
  manifest: ManifestEntry[],
  cases: BenchCase[],
  fixturesDir: string,
  outDir: string,
  deps: {
    readFile: (p: string) => string;
    writeFile: (p: string, data: string) => void;
    mkdirp: (d: string) => void;
  },
): FanoutManifestEntry[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const promptsDir = join(outDir, "prompts");
  deps.mkdirp(promptsDir);
  deps.mkdirp(join(outDir, "raw"));
  return manifest.map((e) => {
    const c = byId.get(e.caseId);
    if (!c)
      throw new Error(`buildManifest referenced unknown case "${e.caseId}"`);
    const id = entryId(e);
    const promptFile = join(promptsDir, `${id}.md`);
    deps.writeFile(
      promptFile,
      composePrompt(c, fixturesDir, e.size, deps.readFile),
    );
    const entry: FanoutManifestEntry = {
      task: id,
      model: e.model,
      promptFile,
      outputFormat: "json",
      out: join(outDir, "raw", `${id}.md`),
    };
    if (e.arm === "schema" && c.jsonSchemaFile) {
      entry.jsonSchema = join(fixturesDir, c.id, c.jsonSchemaFile);
    } else if (e.arm === "free-form" && c.jsonSchemaFile) {
      entry.structuredFallback = join(fixturesDir, c.id, c.jsonSchemaFile);
    }
    return entry;
  });
}

export function loadCases(
  fixturesDir: string,
  deps: {
    readdir: (d: string) => string[];
    readFile: (p: string) => string;
    fileExists: (p: string) => boolean;
  },
): BenchCase[] | { error: string } {
  const dirs = deps.readdir(fixturesDir);
  const cases: BenchCase[] = [];
  for (const dir of dirs) {
    const casePath = join(fixturesDir, dir, "case.json");
    if (!deps.fileExists(casePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(deps.readFile(casePath));
    } catch (err) {
      return {
        error: `${casePath}: not valid JSON: ${(err as Error).message}`,
      };
    }
    const result = validateCase(parsed);
    if (!result.ok) return { error: `${casePath}: ${result.reason}` };
    cases.push(result.value);
  }
  return cases;
}
