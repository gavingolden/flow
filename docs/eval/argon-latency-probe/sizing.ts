import type { EntryResult } from "../../../bin/flow-delegate-fanout";

export type ProbeSurface =
  | "research-gather"
  | "plan-review"
  | "blind-survey"
  | "intent-guess"
  | "review-lens";

// The capped-budget gather variant is recorded beside the uncapped gather but
// is not one of the five production surfaces.
export type ProbeRecordSurface = ProbeSurface | "research-gather-capped";

export type ProbeRecord = {
  surface: ProbeRecordSurface;
  model: string;
  repeat: number;
  wallSec: number;
  ran: boolean;
  empty: boolean;
  timedOut: boolean;
  outputBytes: number;
  deniedActions: string[];
};

export type SizedLimit = {
  limit: string;
  verdict: "fits" | "limit-mismatch" | "stalls";
  medianSec: number;
};

export const FLOOR_SEC = 600;
export const CAP_MIN = 20;
export const STALL_SHARE = 2 / 3;

// Entry tasks are `<surface>__r<repeat>__<model-slug>`; the model itself rides
// on entry.model so the slug is only there to keep task names unique.
const TASK_RE = /^(.+?)__r(\d+)__/;

// A `--output-format json` artifact is an envelope; the answer is its
// structured_output, else its response, else (non-JSON) the raw text.
export function answerBytes(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as {
      structured_output?: unknown;
      response?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      if (
        parsed.structured_output !== undefined &&
        parsed.structured_output !== null
      ) {
        return Buffer.byteLength(JSON.stringify(parsed.structured_output));
      }
      if (typeof parsed.response === "string") {
        return Buffer.byteLength(parsed.response.trim());
      }
    }
  } catch {
    // plain-text artifact — fall through
  }
  return Buffer.byteLength(raw.trim());
}

export function toProbeRecord(
  entry: { task: string; model?: string },
  result: EntryResult,
  outputBytes = 0,
): ProbeRecord {
  const m = TASK_RE.exec(entry.task);
  if (!m) throw new Error(`not a probe task name: ${entry.task}`);
  const timedOut = result.skipReason === "agy-timeout";
  // A timed-out or empty-artifact call produced no usable answer — the same
  // "stalled" signal as a ran call whose answer is zero bytes.
  const empty = result.ran
    ? outputBytes === 0
    : timedOut || result.skipReason === "agy-empty-artifact";
  return {
    surface: m[1] as ProbeRecordSurface,
    model: entry.model ?? result.model ?? "",
    repeat: Number(m[2]),
    wallSec: (result.durationMs ?? 0) / 1000,
    ran: result.ran,
    empty,
    timedOut,
    outputBytes,
    deniedActions: result.deniedActions ?? [],
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// limit = ceil(max(600, 3 x median wallSec) / 60) minutes, capped at 20m
// (limit-mismatch above); stalls when >= 2/3 of the model's calls are empty.
// Over ONE surface's records — the caller groups by surface (see sizeLimits).
export function sizeLimit(records: ProbeRecord[], model: string): SizedLimit {
  const own = records.filter((r) => r.model === model);
  if (own.length === 0) throw new Error(`no probe records for ${model}`);
  const medianSec = median(own.map((r) => r.wallSec));
  const minutes = Math.ceil(Math.max(FLOOR_SEC, 3 * medianSec) / 60);
  const emptyShare = own.filter((r) => r.empty).length / own.length;
  const verdict: SizedLimit["verdict"] =
    emptyShare >= STALL_SHARE
      ? "stalls"
      : minutes > CAP_MIN
        ? "limit-mismatch"
        : "fits";
  return { limit: `${Math.min(minutes, CAP_MIN)}m`, verdict, medianSec };
}

export type SizedLimits = Record<ProbeSurface, Record<string, SizedLimit>> & {
  "research-gather-capped"?: Record<string, SizedLimit>;
};

export function sizeLimits(records: ProbeRecord[]): SizedLimits {
  const out: Record<string, Record<string, SizedLimit>> = {
    "research-gather": {},
    "plan-review": {},
    "blind-survey": {},
    "intent-guess": {},
    "review-lens": {},
  };
  const keys = new Set<string>(records.map((r) => r.surface));
  for (const surface of keys) {
    const rows = records.filter((r) => r.surface === surface);
    out[surface] ??= {};
    for (const model of new Set(rows.map((r) => r.model))) {
      out[surface]![model] = sizeLimit(rows, model);
    }
  }
  return out as SizedLimits;
}
