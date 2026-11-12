// The research limit: gather and fact-check share it (buildManifest applies one
// timeout to both). 20 minutes is the sizing rule's cap
// (docs/eval/argon-latency-probe/README.md): Stage 0 measured the old High-tier
// gather median at 415 s (docs/eval/argon-latency-probe-2026-10.md), so 3x is
// 21 minutes, over the cap — a limit mismatch, shipped at the cap. A
// capped-search variant was 1.35x faster (median 308 s), below
// the 2x bar, so the gather prompt is unchanged. The 3-minute limit it replaces
// cut a gather that had spent 163 s searching with no answer. Callers no longer hold the
// run inside one 10-minute tool call — they launch it with `flow-spawn
// --detach` and wait on the status file (flow-plan-review-wait --pid) — so the
// limit is not bounded by a tool call.
export const DEFAULT_TIMEOUT = "20m";
