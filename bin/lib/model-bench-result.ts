/**
 * Maps one dispatched bench slot's fanout envelope onto a `BenchResult`
 * (split out of `bin/flow-model-bench.ts` to keep that runner thin).
 */

import { join } from "node:path";
import type {
  EntryResult,
  ManifestEntry as FanoutManifestEntry,
} from "../flow-delegate-fanout";
import { classifyAgyFailure } from "./agy-failure-class";
import type { ManifestEntry } from "./model-bench-manifest";
import { parseResetsIn } from "./model-bench-resume";
import type { BenchCase, BenchResult } from "./model-bench-schema";
import { parseStructured } from "./structured-response";

// A ran:false envelope that carries no failureClass of its own (an older
// delegate, or a fake in a test) is classified from its skip reason and error
// text, so every consumer reads one field.
export function withFailureClass(e: EntryResult): EntryResult {
  if (e.ran || e.failureClass) return e;
  return { ...e, failureClass: classifyEnvelope(e) };
}

function classifyEnvelope(env: EntryResult) {
  return classifyAgyFailure({
    skipReason: env.skipReason ?? "",
    stderrTail: env.stderrTail,
    agyError: env.agyError,
    agyStatus: env.agyStatus,
  });
}

export function toBenchResult(input: {
  readFile: (p: string) => string;
  fixturesDir: string;
  cases: BenchCase[];
  slot: ManifestEntry;
  entry: FanoutManifestEntry;
  env: EntryResult;
  schemaCache: Map<string, unknown>;
}): BenchResult {
  const {
    readFile,
    fixturesDir,
    cases,
    slot: e,
    entry,
    env,
    schemaCache,
  } = input;
  const ran = env.ran === true;
  let response: string | undefined;
  let structuredOutput: unknown;
  if (ran) {
    try {
      response = readFile(entry.out ?? "");
    } catch {
      response = undefined;
    }
    // Every bench entry runs --output-format json, so the artifact is the
    // AGY ENVELOPE, not model prose (the documented JSON-mode contract:
    // callers must go through .response / .structured_output). Unwrap it;
    // an unparseable artifact falls through with the raw text as response.
    if (response !== undefined) {
      try {
        const envelope = JSON.parse(response) as Record<string, unknown>;
        if (typeof envelope.response === "string") {
          response = envelope.response;
          if (
            envelope.structured_output !== undefined &&
            envelope.structured_output !== null
          ) {
            structuredOutput = envelope.structured_output;
          }
        }
      } catch {
        // not an envelope (text mode / partial write) — keep raw text
      }
    }
    const c = cases.find((cc) => cc.id === e.caseId);
    if (
      structuredOutput === undefined &&
      response !== undefined &&
      e.arm !== "n/a" &&
      c?.jsonSchemaFile
    ) {
      const schemaPath = join(fixturesDir, c.id, c.jsonSchemaFile);
      if (!schemaCache.has(schemaPath)) {
        try {
          schemaCache.set(schemaPath, JSON.parse(readFile(schemaPath)));
        } catch {
          schemaCache.set(schemaPath, undefined);
        }
      }
      const attempt = parseStructured(response, schemaCache.get(schemaPath));
      if (attempt.ok) structuredOutput = attempt.value;
    }
  }
  const result: BenchResult = {
    caseId: e.caseId,
    arm: e.arm,
    model: e.model,
    repeat: e.repeat,
    warmup: e.warmup,
    ran,
  };
  if (env.skipReason) result.skipReason = env.skipReason;
  if (env.durationSeconds !== undefined)
    result.durationSeconds = env.durationSeconds;
  if (env.usage) result.usage = env.usage;
  if (response !== undefined) result.response = response;
  if (structuredOutput !== undefined)
    result.structuredOutput = structuredOutput;
  if (env.parseRetries !== undefined) result.parseRetries = env.parseRetries;
  if (e.size !== undefined) result.size = e.size;
  if (env.deniedActions?.length) result.deniedActions = env.deniedActions;
  if (!ran) {
    const failureClass = env.failureClass ?? classifyEnvelope(env);
    result.failureClass = failureClass;
    const resetsIn = parseResetsIn(
      `${env.agyError ?? ""} ${env.stderrTail ?? ""}`,
    );
    if (resetsIn) result.resetsIn = resetsIn;
  } else if (env.deniedActions?.length && !(response ?? "").trim()) {
    // Production behaviour (a refused tool, an empty answer): still counted,
    // but reported as its own class rather than a model failure.
    result.failureClass = "tool-denied-empty";
  }
  return result;
}
