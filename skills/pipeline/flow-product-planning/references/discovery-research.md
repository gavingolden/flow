# Discovery Step 1.5 research procedure (read only when research fires)

When `RESEARCH_ON` is `true` (or `FORCE_RESEARCH` is `true`), also resolve the four **optional budget overrides** from the same `.research` object before building the manifest in (c). Each is **tolerant by construction with one twist over the boolean read in discovery-instructions.md Step 1.5 (a)**: an absent key silently takes its v1 default; a key that is **present but the wrong JSON type emits a loud `stderr` warning and then falls back to the default** — it never throws and never aborts the pass (a config typo must degrade to a warning, mirroring the `allSkipped` graceful-skip discipline — research never blocks planning). A bare `// default` is **insufficient** because it only defaults on `null`/missing, not on a present wrong-type value, so each read type-guards explicitly:

```bash
CFG=~/.flow/config.json

# Tolerant per-key read. $1=key $2=expected-jq-type $3=default.
# absent -> silent default; present-but-wrong-type -> loud stderr warning + default;
# missing/malformed config file -> default. Never throws, never aborts.
read_budget() {
  local raw
  raw=$(jq -r "
    if (.research.$1) == null then \"__ABSENT__\"
    elif (.research.$1 | type) == \"$2\" then (.research.$1 | tostring)
    else \"__INVALID__\" end" "$CFG" 2>/dev/null) || raw="__ABSENT__"
  if [ "$raw" = "__ABSENT__" ] || [ -z "$raw" ]; then
    printf '%s' "$3"
  elif [ "$raw" = "__INVALID__" ]; then
    printf 'warn: research.%s is present but not a %s; using default %s\n' "$1" "$2" "$3" >&2
    printf '%s' "$3"
  else
    printf '%s' "$raw"
  fi
}

RESEARCH_MAX_CALLS=$(read_budget maxCalls number 12)
RESEARCH_TIMEOUT=$(read_budget timeout string "3m")
RESEARCH_MODEL=$(read_budget model string "Gemini 3.1 Pro (High)")
RESEARCH_REFUTE_MODEL=$(read_budget refuteModel string "Claude Opus 4.6 (Thinking)")

# Cross-model diversity guard: the REFUTE entry MUST run on a DIFFERENT variant
# from GATHER (the adversarial check is worthless if both run the same model).
# If the resolved refute model collides with gather, warn and fall back to a
# pinned alternate that differs.
if [ "$RESEARCH_REFUTE_MODEL" = "$RESEARCH_MODEL" ]; then
  if [ "$RESEARCH_MODEL" = "Claude Opus 4.6 (Thinking)" ]; then
    RESEARCH_REFUTE_MODEL="GPT-OSS 120B (Medium)"
  else
    RESEARCH_REFUTE_MODEL="Claude Opus 4.6 (Thinking)"
  fi
  printf 'warn: research.refuteModel resolved equal to the gather model (%s); falling back refute to %s to preserve adversarial diversity\n' "$RESEARCH_MODEL" "$RESEARCH_REFUTE_MODEL" >&2
fi
```

The four resolved variables — `RESEARCH_MAX_CALLS` (from `research.maxCalls`, default `12`), `RESEARCH_TIMEOUT` (from `research.timeout`, default `3m`), `RESEARCH_MODEL` (the gather model, from `research.model`, default `Gemini 3.1 Pro (High)`), and `RESEARCH_REFUTE_MODEL` (the refute model, from `research.refuteModel`, default `Claude Opus 4.6 (Thinking)`) — are threaded into the manifest and the `flow-delegate-fanout` invocation in (c). `--concurrency` stays pinned at `4` (not operator-tunable — it is load-bearing in the runtime-ceiling arithmetic). These four defaults and the byte-exact model-variant pins are frozen by `bin/flow-research-budget-lint.test.ts`, which goes red if an edit drops a default or breaks the tolerant-fallback contract.

**(c) Run the bounded research by driving `flow-delegate-fanout` directly (Bash).** You deliberately do **NOT** load `/flow-research` via the `Skill` tool (its default budget suits an interactive caller; see the HARD INVARIANT). Instead, `Read` the `/flow-research` procedure for the recipe — it is on disk globally at `~/.flow/claude-home/.claude/skills/universal/flow-research/SKILL.md` (the byte-exact model-variant pins, the gather→refute→synthesize shape, the cap discipline) — and run the fan-out yourself.

**Module precheck (before anything else in this step, including the cache read below).** A deselected `research` module means every helper this step touches — `flow-research-cache`, `flow-delegate-fanout`, `flow-delegate` — was pruned from PATH entirely. Probe first, by bare PATH name, same as the other reads in this step:

```bash
flow-module-status --check research || RESEARCH_MODULE_INACTIVE=1
```

When `$RESEARCH_MODULE_INACTIVE` is set, the helper already emitted the named notice to stderr — skip the fan-out (and the cache read) entirely and take the SAME graceful-skip path as (e), reusing its machinery rather than inventing a new one: write `research-status.json` with `"reason": "research-deselected"` (extending the (e)/Visibility-note reason enum in discovery-instructions.md Step 1.5) and the SAME `> [!NOTE]` visibility-note write, naming the deselected module in place of the agy-unavailable reason text. Then proceed to step 2 unchanged.

**Cache-read first (before building the manifest).** A prior identical run may already have synthesized this exact question, so check the host-wide research cache before paying for a fresh fan-out. Run it by **bare PATH name** via Bash — exactly like the `jq` and `flow-delegate-fanout` invocations above, NOT a `bin/lib` import (Step 1.5 runs in the consumer/target worktree where flow's `bin/lib` is absent):

```bash
CACHED_SYNTHESIS=$(flow-research-cache get --question "<the sharp question from 1.5(b)>" 2>/dev/null) && CACHE_HIT=true || CACHE_HIT=false
```

The cache key is the **normalized** sharp question (lowercase / trim / collapse-whitespace → SHA-256), so a same-scope redirect or a crash-resume forms the same question → same key → **hit**, while a scope-changing redirect forms a NEW question → new key → **miss** → re-research. The cache is host-wide at `~/.flow/research-cache/` with a default 48h TTL. Discovery keys on the **bare** normalized question; direct `/flow-research` invocations share the same cache under a **distinct namespaced keyspace** (the direct path's namespace prefix), so the two paths don't serve each other the wrong-shaped artifact (discovery's bounded plan summary vs. direct's full cited report). That isolation is by construction, not an absolute key-collision impossibility — a collision would require a discovery question that itself began with the direct path's namespace prefix, which discovery never composes.

- **On exit 0 (hit):** the cached synthesis is now captured in `$CACHED_SYNTHESIS` (printed to stdout by the `get`). Reuse `$CACHED_SYNTHESIS` as the research prior context and **SKIP the entire fan-out below AND the 1.5(d) synthesis** — fold it directly into your plan per the (d) constraints (confidence labels intact, refuted claims → risks, no raw artifacts).
- **On any NON-ZERO exit (miss / stale / corrupt — exit 3, or even a 2 from a wiring bug):** `$CACHED_SYNTHESIS` is empty; treat it as a **graceful miss** and run the fan-out live exactly as below. The `get` must NEVER error the discovery run — branch on the cache miss and proceed.

When you take the live path (cache miss), build the manifest and run the fan-out:

1. Build a small manifest JSON file with THREE entries: a GATHER entry on the resolved gather model `$RESEARCH_MODEL` (default `"Gemini 3.1 Pro (High)"`; agy has native Google web search — instruct it to return cited source URLs) asking your sharp question; an adversarial REFUTE entry on the resolved `$RESEARCH_REFUTE_MODEL` (default `"Claude Opus 4.6 (Thinking)"`; the cross-model guard in (a) keeps it a **different** variant from gather — the pinned alternates are `"Claude Opus 4.6 (Thinking)"` and `"GPT-OSS 120B (Medium)"`) that checks the gathered claim; and a third `refute-approach` entry, also on `$RESEARCH_REFUTE_MODEL`, prompted to find evidence that the user's CHOSEN APPROACH (not just the gathered claim) fails or is worse than the obvious alternative — its artifact feeds the `## Request vetting` `- **Case against:**` line (see the "Request vetting" sub-section, step 5) as a bonus grounding source on top of in-repo anchors. Each entry's shape is `{ "task": "...", "model": "...", "prompt": "...", "timeout": "...", "skipPermissions": true, "outputFormat": "json" }` — **set every entry's `model` to the resolved gather/refute variant, every entry's `timeout` to the resolved `$RESEARCH_TIMEOUT` (default `"3m"`), and every entry's `skipPermissions` to `true` with `outputFormat` set to `"json"`**. **Do NOT set `addDirs` on any entry** — omitting it is what keeps the auto-approval grant bounded to agy's own tools (no workspace directory reachable); `outputFormat: "json"` makes a refused tool nameable via the envelope's `deniedActions` (see the rationale below). Three entries at `--concurrency 4` still fit in ONE wave, so the runtime-ceiling arithmetic below is unaffected.
2. Run: `flow-delegate-fanout --manifest <file> --max-calls "$RESEARCH_MAX_CALLS" --concurrency 4 --out <out.json> --default-entry-timeout "$RESEARCH_TIMEOUT"` (`$RESEARCH_MAX_CALLS` defaults to `12`; `$RESEARCH_TIMEOUT` defaults to `3m`; `--concurrency` stays pinned at `4`).
3. **The fan-out's own result is the agy-availability check — no separate probe.** If the aggregate is `allSkipped: true` (every entry `ran: false` with `skipReason: agy-not-found` / `agy-not-authenticated`), agy is unavailable: take the graceful skip in (e). Otherwise read the per-entry artifacts under `<out-dir>/artifacts/` and synthesize the report yourself (d). A non-`allSkipped` aggregate carrying any `ran: false` entry is folded into the plan as a named limitation (in plain language), never read as an absence of findings.

**Budget is config-tunable within a HARD runtime ceiling:** `--max-calls` (the resolved `$RESEARCH_MAX_CALLS`, default `12`) is a real `flow-delegate-fanout` flag that hard-caps the total call count; the per-call timeout is the per-manifest-entry `timeout` field (the resolved `$RESEARCH_TIMEOUT`, default `"3m"`) you set on every entry. `--default-entry-timeout "$RESEARCH_TIMEOUT"` is the fanout-level **backstop** that HARD-enforces that per-call cap: any entry that omits its own `timeout` is dispatched with the resolved `$RESEARCH_TIMEOUT` instead of silently falling back to agy's 5-minute default. You SHOULD still set `timeout` on every manifest entry yourself — a per-entry `timeout` always wins over the flag, and being explicit keeps the manifest self-documenting; the flag is the safety net for when an entry forgets it. (Note: per-entry `--timeout` is **not** a `flow-delegate-fanout` flag — its parser rejects unknown flags — so the per-call cap lives only in the per-manifest-entry `timeout` field; `--default-entry-timeout` is the fanout-level default for that field, not a per-entry override.) An operator may override `maxCalls`, `timeout`, `model`, and `refuteModel` via `~/.flow/config.json` (resolved in (a)); `--concurrency` stays pinned at `4` and is **not** tunable, because it is load-bearing in the runtime-ceiling arithmetic below.

_Runtime-ceiling rationale._ You are a **one-shot Task sub-agent with no yield/resume** — the supervisor awaits a single invocation and your whole research run executes synchronously inside it. `flow-delegate-fanout`'s "background the fan-out, persist to `--out`, a resumed turn reads the result file" pattern is the **supervisor's** safety net and does **NOT** apply to you (a sub-agent gets no resumed turns). So the synchronous run **must** stay well under the observed-safe ~10-min sub-agent wall-clock: `ceil(12 / 4) = 3` waves × a 3-min per-call cap = **9-min worst case** (typically ~4.5 min). `--max-calls 12` alone is insufficient — at agy's 5-min default timeout the worst case is 15 min (3 waves × 5m), over the ceiling — so the per-entry `timeout: "3m"` cap is the **load-bearing co-requirement**. **Runtime-ceiling advisory (now that `maxCalls`/`timeout` are tunable):** the synchronous worst case is `ceil(maxCalls / concurrency) × timeout`; the defaults (`12` / `3m`, with `--concurrency 4`) sit at the ~9-min worst case above, but raising `research.maxCalls` and `research.timeout` together can blow past the observed-safe ~10-min one-shot sub-agent wall-clock (e.g. `maxCalls: 20, timeout: "5m"` → `ceil(20/4) = 5` waves × 5m = 25 min). When tuning, keep the product under ~10 min — this is advisory, not enforced (there is no executable parser to validate it, by design).

**(d) Synthesize, then fold a bounded, confidence-labeled findings summary into your prior context.** Read the fan-out's per-entry artifacts (the gather's cited findings + the refute's adversarial check, under `<out-dir>/artifacts/`). Each artifact is now a `--output-format json` envelope, not raw prose — before synthesizing, unwrap it: prefer `structured_output` when present, else `response`, else (only if the file fails to parse as JSON) fall back to the raw artifact text. Check `denied_actions` on each envelope too — a non-empty list means agy refused a tool and the entry may carry little or no usable content; fold that into the plan as a named limitation (see the fan-out-result step above), never silently read as "nothing was found." Once unwrapped, synthesize a confidence-ranked summary yourself, and fold a **bounded** version into your discovery reasoning — and, where load-bearing, surface a short **"Research findings (prior context)"** note in `plan.md`. Constraints on what enters the plan:

- **Each finding carries its confidence label (high/medium/low) INTACT.** Never flatten the gathered confidence ranking into false certainty.
- **Refuted, contested, or low-confidence claims become RISKS or open questions — NEVER firm plan assumptions or decisions.** This is the uncertainty-laundering guard: a gathered-but-shaky claim must not become a load-bearing decision.
- **Never paste raw per-source artifacts or full-length quotes into `plan.md`.** Only the bounded summary — bound your own synthesis (top-N ranked claims, capped quotes, no raw pages), exactly as the `/flow-research` procedure you read prescribes.

**Cache-write (after the synthesis is produced).** Persist the bounded synthesis so the next identical re-run (same-scope redirect / crash-resume) hits and skips the fan-out. Write the synthesis to a file and store it by **bare PATH name** under the SAME normalized sharp question used for the read in (c):

```bash
flow-research-cache put --question "<the same sharp question from 1.5(b)>" --synthesis-file <synthesis-file>
```

(or pipe the synthesis via `--synthesis -`). This is a no-op on the cache-hit path — you only reach (d) on a miss. The `put` is best-effort: a write failure must not error discovery.
