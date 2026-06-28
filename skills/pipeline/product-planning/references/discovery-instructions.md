# Discovery instructions

These instructions are read by the discovery subagent that `/product-planning`'s
SKILL.md spawns via the Task tool. The subagent runs in an isolated context — its
file reads, codebase scans, reference loads, and PRD drafting prose stay inside its
own session and are never returned to the caller. The only outputs it produces are
the two artifacts it writes to disk (`.flow-tmp/plan.md` and
`.flow-tmp/pr-description-draft.md`) and a brief one-paragraph summary it returns
on completion.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim user feature description.
- The absolute worktree path (your working directory).
- The absolute skill base directory (`SKILL_DIR`). Resolve every sibling
  template/reference path under it — e.g. `<SKILL_DIR>/templates/prd-template.md`,
  `<SKILL_DIR>/references/architecture-patterns.md`,
  `<SKILL_DIR>/references/discovery-playbook.md`,
  `<SKILL_DIR>/references/example-prd.md`. Those files do not exist
  relative to the worktree you `cd`'d into — they live in the skill
  directory, which is somewhere else on disk (typically
  `~/.claude/skills/product-planning/` or
  `<flow-checkout>/skills/pipeline/product-planning/`).
- The absolute path to write `plan.md`.
- The absolute path to write `pr-description-draft.md`.

Follow the steps below in order.

## 1. Load Project Context

Before forming an opinion, load background context so your scoping is informed:

- Read `README.md` (if present) for architecture, tech stack, and existing capabilities.
- Scan the project's source tree to understand existing modules and domain models.
- Check the database schema location (if one exists) when the feature involves persistence.
- List `.claude/skills/` (or the project's skill directory) to see the current skill set —
  do not hardcode a static list when assigning skills in step 6.
- If `<SKILL_DIR>/references/architecture-patterns.md` exists, load it to verify which
  pattern applies. Otherwise derive patterns from the codebase as you discover them.
- If `<SKILL_DIR>/references/example-prd.md` exists, load it to see what "good" looks
  like for this project.

This is read-only background — these reads stay in your context and don't propagate.

## 1.5. Optional web-grounded research pre-check

This step is **off by default** and runs at most once. It lets a pipeline gather current, web-grounded, adversarially-verified evidence **before** planning, so a plan whose viability turns on an external factual question is grounded on real evidence rather than your training cutoff. It runs **only when** (1) a `jq` read of the global `~/.flow/config.json` returns `research.discovery: true`, AND (2) the relevance gate below judges the feature researchable. agy availability is checked **last**, by the research fan-out itself — an `allSkipped` result means agy is unavailable, so research gracefully no-ops. When any gate fails, skip the entire step and proceed to step 2 (Scope Check) with discovery exactly as it is today. **One override:** a `RESEARCH: force-on` signal in your spawn prompt (set by `flow new --research`) forces the pre-check on, bypassing **both** gate (1) and gate (2) — see (a0) below; only the agy guard still applies.

**HARD INVARIANT (read first).** This research is a **Bash fan-out you call directly**: you run `flow-delegate-fanout` (a Bash subprocess) yourself. A spawned Task sub-agent — which is what you are — does **NOT** have the `Skill` tool, so you **cannot** load `/flow-research` in-process; instead you `Read` its procedure (it is on disk globally — see (c)) and drive the fan-out yourself. You are the orchestrating "Claude" for the gather→refute→synthesize pattern, and you spawn **no** nested Task. The single supervisor→discovery Task call is unchanged and the nine-exemption count in `flow-pipeline/SKILL.md` is preserved. If you find yourself reaching for the Task/Agent tool — or expecting a `Skill` tool that a sub-agent does not have — stop; direct `flow-delegate-fanout` via Bash is the only mechanism here.

Procedure:

**(a0) Force-on override (read this first).** Your discovery spawn prompt may carry a `RESEARCH: force-on` signal — `/flow-pipeline` step 3 folds it in when `flow new --research` set `forceResearch: true` in state.json, and the `/product-planning` spawn template forwards it. When that signal is present, set `FORCE_RESEARCH=true` and **bypass BOTH the `research.discovery` config opt-in in (a) AND the relevance gate in (b)** — proceed straight to forming the sharp, codebase-grounded research question (the final paragraph of (b)) and running the fan-out in (c). This is a **separate branch above** the config read below; it does not invert or relax that read for any non-forced pipeline. The force-on path skips only those two cheap gates — it does **not** ignore the agy guard: the fan-out's `allSkipped` graceful no-op in (c)/(e) still applies, so a forced run on a host without agy still degrades to unchanged discovery (and emits the visibility note in (e)). Absent the signal, set `FORCE_RESEARCH=false` and apply (a)/(b) exactly as before.

**(a) Read the opt-in.** Read the global config opt-in directly with `jq`. The discovery sub-agent runs in the _target repo's_ worktree — which is NOT flow's own repo on a consumer pipeline — so it must read the always-present global `~/.flow/config.json` rather than importing flow's internal `bin/lib` (which is not on PATH in a consumer worktree):

```bash
jq -e '(.research | type == "object") and (.research.discovery == true)' ~/.flow/config.json >/dev/null 2>&1 && RESEARCH_ON=true || RESEARCH_ON=false
```

This is tolerant by construction: a missing file, malformed JSON, an absent or non-object `research`, or a non-`true` `research.discovery` all yield `RESEARCH_ON=false` — only a strict boolean `true` enables. If `RESEARCH_ON` is not `true` **and `FORCE_RESEARCH` is not `true`** (see (a0)), skip this whole step and proceed to step 2 unchanged. Otherwise continue to the relevance gate in (b) — or, when `FORCE_RESEARCH` is `true`, straight to the sharp-question paragraph at the end of (b). **agy availability is deliberately NOT probed here** — the relevance gate is cheaper and rules out most features, so a non-researchable pass should never pay an agy call. agy is checked last, in (c), by the fan-out's own `allSkipped` result.

When `RESEARCH_ON` is `true` (or `FORCE_RESEARCH` is `true`), also resolve the four **optional budget overrides** from the same `.research` object before building the manifest in (c). Each is **tolerant by construction with one twist over the boolean read above**: an absent key silently takes its v1 default; a key that is **present but the wrong JSON type emits a loud `stderr` warning and then falls back to the default** — it never throws and never aborts the pass (a config typo must degrade to a warning, mirroring the `allSkipped` graceful-skip discipline — research never blocks planning). A bare `// default` is **insufficient** because it only defaults on `null`/missing, not on a present wrong-type value, so each read type-guards explicitly:

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

**(b) Cheap relevance + sharp-question pre-check (one Claude step).** Decide whether THIS feature turns on a researchable external question. Use this concrete checklist — it is enumerable, not vibes. **When `FORCE_RESEARCH` is `true` (a0), skip this relevance gate entirely** — the user has already opted in — and jump to the sharp-question paragraph below:

- **Researchable** (the feature's viability turns on an external/factual question with an authoritative answer). Worked examples:
  - _Integrating or adopting an external API / spec / standard_ — e.g. "add CSV export" hinges on whether RFC 4180 quote-escaping is required for the fields we emit; "integrate the Stripe refund API" hinges on the current request shape and idempotency-key rules.
  - _A security or correctness question with an authoritative answer_ — e.g. "is the OAuth refresh-token rotation flow we're about to copy still the recommended pattern?"; "what's the safe argon2 work-factor for our threat model?"
  - _A "current best practice for X" question_ — e.g. "what's the current recommended way to debounce a SvelteKit form action?"; "what's the current rate limit on the GitHub Search API we're about to call?"
- **NOT researchable** (a pure-internal change fully determined by existing code/patterns). Worked examples:
  - _A CSS / layout tweak_ — e.g. "fix the button alignment on the settings page"; "tighten the card padding".
  - _A rename_ — e.g. "rename `fetchUser` to `loadUser` across the repo".
  - _A pure-internal refactor_ — e.g. "extract this 40-line block into a helper"; "collapse these two near-identical functions".
  - _Wiring two existing modules_ — e.g. "call the existing `exportCsv` from the new toolbar button"; "pass the already-computed total into the existing renderer".
- **Safe-by-default tie-breaker (load-bearing).** When you cannot **confidently** place the feature in the researchable bucket, **default to NOT researching.** The failure modes are **asymmetric**: a false positive costs ~15 min of latency + agy quota + user annoyance; a false negative costs ~nothing — it is exactly today's no-research behavior. This mirrors `/flow-research`'s own "default to refuted if uncertain" discipline. Do not research a borderline case to be safe — the safe default is to skip.

If the verdict is **not researchable** (non-forced path only — a `FORCE_RESEARCH=true` run never reaches this verdict), take no fan-out — proceed to step 2 unchanged, but first emit the visibility note in (e). If **researchable** (or `FORCE_RESEARCH` is `true`), form a **sharp, codebase-grounded research question** (NOT the verbatim feature description — only something that knows this codebase can ask the right question; e.g. not "add CSV export" but "does RFC 4180 require quoting/escaping for the `,`- and newline-bearing fields the portfolio export emits, and which line terminator do mainstream spreadsheet importers expect?").

**(c) Run the bounded research by driving `flow-delegate-fanout` directly (Bash).** You **cannot** load `/flow-research` via the Skill tool — a spawned sub-agent does not have it (see the HARD INVARIANT). Instead, `Read` the `/flow-research` procedure for the recipe — it is on disk globally at `~/.claude/skills/universal/flow-research/SKILL.md` (the byte-exact model-variant pins, the gather→refute→synthesize shape, the cap discipline) — and run the fan-out yourself.

**Cache-read first (before building the manifest).** A prior identical run may already have synthesized this exact question, so check the host-wide research cache before paying for a fresh fan-out. Run it by **bare PATH name** via Bash — exactly like the `jq` and `flow-delegate-fanout` invocations above, NOT a `bin/lib` import (Step 1.5 runs in the consumer/target worktree where flow's `bin/lib` is absent):

```bash
CACHED_SYNTHESIS=$(flow-research-cache get --question "<the sharp question from 1.5(b)>" 2>/dev/null) && CACHE_HIT=true || CACHE_HIT=false
```

The cache key is the **normalized** sharp question (lowercase / trim / collapse-whitespace → SHA-256), so a same-scope redirect or a crash-resume forms the same question → same key → **hit**, while a scope-changing redirect forms a NEW question → new key → **miss** → re-research. The cache is host-wide at `~/.flow/research-cache/` with a default 48h TTL. Discovery keys on the **bare** normalized question; direct `/flow-research` invocations share the same cache under a **distinct namespaced keyspace** (the direct path's namespace prefix), so the two paths don't serve each other the wrong-shaped artifact (discovery's bounded plan summary vs. direct's full cited report). That isolation is by construction, not an absolute key-collision impossibility — a collision would require a discovery question that itself began with the direct path's namespace prefix, which discovery never composes.

- **On exit 0 (hit):** the cached synthesis is now captured in `$CACHED_SYNTHESIS` (printed to stdout by the `get`). Reuse `$CACHED_SYNTHESIS` as the research prior context and **SKIP the entire fan-out below AND the 1.5(d) synthesis** — fold it directly into your plan per the (d) constraints (confidence labels intact, refuted claims → risks, no raw artifacts).
- **On any NON-ZERO exit (miss / stale / corrupt — exit 3, or even a 2 from a wiring bug):** `$CACHED_SYNTHESIS` is empty; treat it as a **graceful miss** and run the fan-out live exactly as below. The `get` must NEVER error the discovery run — branch on the cache miss and proceed.

When you take the live path (cache miss), build the manifest and run the fan-out:

1. Build a small manifest JSON file: a GATHER entry on the resolved gather model `$RESEARCH_MODEL` (default `"Gemini 3.1 Pro (High)"`; agy has native Google web search — instruct it to return cited source URLs) asking your sharp question, plus an adversarial REFUTE entry on the resolved `$RESEARCH_REFUTE_MODEL` (default `"Claude Opus 4.6 (Thinking)"`; the cross-model guard in (a) keeps it a **different** variant from gather — the pinned alternates are `"Claude Opus 4.6 (Thinking)"` and `"GPT-OSS 120B (Medium)"`) that checks the gathered claim. Each entry's shape is `{ "task": "...", "model": "...", "prompt": "...", "timeout": "..." }` — **set every entry's `model` to the resolved gather/refute variant and every entry's `timeout` to the resolved `$RESEARCH_TIMEOUT` (default `"3m"`)** (see the rationale below).
2. Run: `flow-delegate-fanout --manifest <file> --max-calls "$RESEARCH_MAX_CALLS" --concurrency 4 --out <out.json> --default-entry-timeout "$RESEARCH_TIMEOUT"` (`$RESEARCH_MAX_CALLS` defaults to `12`; `$RESEARCH_TIMEOUT` defaults to `3m`; `--concurrency` stays pinned at `4`).
3. **The fan-out's own result is the agy-availability check — no separate probe.** If the aggregate is `allSkipped: true` (every entry `ran: false` with `skipReason: agy-not-found` / `agy-not-authenticated`), agy is unavailable: take the graceful skip in (e). Otherwise read the per-entry artifacts under `<out-dir>/artifacts/` and synthesize the report yourself (d).

**Budget is config-tunable within a HARD runtime ceiling:** `--max-calls` (the resolved `$RESEARCH_MAX_CALLS`, default `12`) is a real `flow-delegate-fanout` flag that hard-caps the total call count; the per-call timeout is the per-manifest-entry `timeout` field (the resolved `$RESEARCH_TIMEOUT`, default `"3m"`) you set on every entry. `--default-entry-timeout "$RESEARCH_TIMEOUT"` is the fanout-level **backstop** that HARD-enforces that per-call cap: any entry that omits its own `timeout` is dispatched with the resolved `$RESEARCH_TIMEOUT` instead of silently falling back to agy's 5-minute default. You SHOULD still set `timeout` on every manifest entry yourself — a per-entry `timeout` always wins over the flag, and being explicit keeps the manifest self-documenting; the flag is the safety net for when an entry forgets it. (Note: per-entry `--timeout` is **not** a `flow-delegate-fanout` flag — its parser rejects unknown flags — so the per-call cap lives only in the per-manifest-entry `timeout` field; `--default-entry-timeout` is the fanout-level default for that field, not a per-entry override.) An operator may override `maxCalls`, `timeout`, `model`, and `refuteModel` via `~/.flow/config.json` (resolved in (a)); `--concurrency` stays pinned at `4` and is **not** tunable, because it is load-bearing in the runtime-ceiling arithmetic below.

_Runtime-ceiling rationale._ You are a **one-shot Task sub-agent with no yield/resume** — the supervisor awaits a single invocation and your whole research run executes synchronously inside it. `flow-delegate-fanout`'s "background the fan-out, persist to `--out`, a resumed turn reads the result file" pattern is the **supervisor's** safety net and does **NOT** apply to you (a sub-agent gets no resumed turns). So the synchronous run **must** stay well under the observed-safe ~10-min sub-agent wall-clock: `ceil(12 / 4) = 3` waves × a 3-min per-call cap = **9-min worst case** (typically ~4.5 min). `--max-calls 12` alone is insufficient — at agy's 5-min default timeout the worst case is 15 min (3 waves × 5m), over the ceiling — so the per-entry `timeout: "3m"` cap is the **load-bearing co-requirement**. **Runtime-ceiling advisory (now that `maxCalls`/`timeout` are tunable):** the synchronous worst case is `ceil(maxCalls / concurrency) × timeout`; the defaults (`12` / `3m`, with `--concurrency 4`) sit at the ~9-min worst case above, but raising `research.maxCalls` and `research.timeout` together can blow past the observed-safe ~10-min one-shot sub-agent wall-clock (e.g. `maxCalls: 20, timeout: "5m"` → `ceil(20/4) = 5` waves × 5m = 25 min). When tuning, keep the product under ~10 min — this is advisory, not enforced (there is no executable parser to validate it, by design).

**(d) Synthesize, then fold a bounded, confidence-labeled findings summary into your prior context.** Read the fan-out's per-entry artifacts (the gather's cited findings + the refute's adversarial check, under `<out-dir>/artifacts/`), synthesize a confidence-ranked summary yourself, and fold a **bounded** version into your discovery reasoning — and, where load-bearing, surface a short **"Research findings (prior context)"** note in `plan.md`. Constraints on what enters the plan:

- **Each finding carries its confidence label (high/medium/low) INTACT.** Never flatten the gathered confidence ranking into false certainty.
- **Refuted, contested, or low-confidence claims become RISKS or open questions — NEVER firm plan assumptions or decisions.** This is the uncertainty-laundering guard: a gathered-but-shaky claim must not become a load-bearing decision.
- **Never paste raw per-source artifacts or full-length quotes into `plan.md`.** Only the bounded summary — bound your own synthesis (top-N ranked claims, capped quotes, no raw pages), exactly as the `/flow-research` procedure you read prescribes.

**Cache-write (after the synthesis is produced).** Persist the bounded synthesis so the next identical re-run (same-scope redirect / crash-resume) hits and skips the fan-out. Write the synthesis to a file and store it by **bare PATH name** under the SAME normalized sharp question used for the read in (c):

```bash
flow-research-cache put --question "<the same sharp question from 1.5(b)>" --synthesis-file <synthesis-file>
```

(or pipe the synthesis via `--synthesis -`). This is a no-op on the cache-hit path — you only reach (d) on a miss. The `put` is best-effort: a write failure must not error discovery.

**Cache GC (separate from the per-`get` TTL miss).** The per-`get` TTL only treats stale entries as _misses_ — it never deletes them, so the cache grows unbounded and a crashed mid-write can leave orphan `<key>.json.<pid>.tmp` files behind. `flow-research-cache prune` is an opt-in GC sweep that reclaims space without changing the `get`/`put` key-normalization or TTL-miss contract: it deletes entries older than `--max-age-hours` (default 48h, the TTL), evicts oldest-by-`createdAt` down to `--max-entries` (default 500), removes corrupt/unparseable entries, and cleans orphan `.tmp` files older than `--tmp-max-age-hours` (default 1h, so a live `put`'s write-then-rename is never raced). It always exits 0, never throws, and supports `--dry-run`; limits resolve `flag > env > default` (`FLOW_RESEARCH_CACHE_MAX_ENTRIES`, `FLOW_RESEARCH_CACHE_MAX_AGE_HOURS`, `FLOW_RESEARCH_CACHE_TMP_MAX_AGE_HOURS`). Setting `FLOW_RESEARCH_CACHE_SWEEP_ON_PUT` to a truthy value runs a best-effort sweep after each successful `put` (off by default — a sweep failure never fails the write). There is no daemon: the cache is bounded only when `prune` runs (manually, or via the on-put sweep).

**(e) Graceful skip / not-researchable → unchanged discovery.** If the relevance verdict was "not researchable", or the fan-out's aggregate is `allSkipped: true` (agy unavailable), take no research-derived prior context and proceed to step 2 exactly as discovery behaves today — research availability never blocks planning, and both `plan.md` and `pr-description-draft.md` are still written normally. Branch the agy skip on the fan-out's `allSkipped` field, **never** the exit code.

**Visibility note (when the research path was active but no research ran).** The research path is **active** whenever `RESEARCH_ON` is `true` OR `FORCE_RESEARCH` is `true`. When the path was active but no research actually ran — i.e. the relevance verdict was "not researchable" (non-forced path only), OR agy was unavailable / the fan-out came back `allSkipped` (either path) — write a single-line `> [!NOTE]` blockquote into `plan.md` naming the reason and how to force the research next time, e.g.:

```
> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — agy unavailable on this host; force with `flow new --research`.
```

(swap the reason for `not a researchable question` on the not-researchable path). **Also append the same one-liner to your Step-9 discovery return summary** so it reaches the supervisor's chat. Stay **silent** in the fully-dormant case (config off AND not forced — `RESEARCH_ON` and `FORCE_RESEARCH` both `false`): the path was never active, so no note is written and the return summary says nothing about research. This mirrors the omit-when-empty discipline the `# Candidate follow-up issues` and `## Prompt interpretation` sections already use — a run that actually DID research never emits a misleading "skipped" line either.

## 2. Scope Check

After loading context, decide whether the idea warrants a full PRD. Not every feature
needs one — a full PRD is overhead that slows down small changes.

**Use the full PRD flow (steps 3–8)** when:

- The feature spans 3+ domain layers (DB, backend, domain model, UI).
- It introduces a new domain module or database table.
- There are meaningful architectural decisions to make.
- The user explicitly asks for a PRD or detailed plan.

**Use a lightweight task breakdown** (skip directly to step 6 with a 2–3-sentence
problem statement instead of a full PRD) when:

- The feature is contained within a single domain area (e.g., adding a method to an
  existing repository, adding a button that calls existing logic).
- It can be expressed in 1–3 tasks.
- The architecture is obvious from existing patterns.

Either path still produces the same `.flow-tmp/plan.md` artifact — the difference is
the depth of the PRD section.

## 3. Discovery — make informed assumptions, surface ambiguity

You are a one-shot subagent. You cannot ask the user clarifying questions; the Task
tool returns one result and exits. When the user's description leaves something
unspecified:

- **Make a defensible assumption** based on the codebase, the project's existing
  patterns, and reasonable defaults for this kind of feature.
- **Surface every assumption you made** in the PRD's "Open Questions" section, written
  as one bullet per assumption: what you assumed, why, and what the user should
  confirm or redirect.

The user iterates by either redirecting at `plan-pending-review` (when invoked from
`/flow-pipeline`) or re-invoking `/product-planning` with refinements (manual mode).
Your job is not to ask — it's to produce a plan grounded enough that the user can
either approve it or redirect with a single message.

When forming assumptions, lean on these signals:

- **Existing code patterns.** If the codebase already does something analogous, follow
  that pattern unless there's a stated reason to deviate. Reference the pattern by
  file path in the PRD.
- **AGENTS.md / CLAUDE.md.** Project-level rules constrain valid approaches. Re-read
  them before finalizing — a plan that conflicts with documented constraints is a
  rework risk.
- **Verbatim user description.** Quote the user's words back when they're load-bearing
  ("the user said 'each row gets a `$` column'") so the assumption is anchored on
  what they actually wrote, not on your paraphrase.

Categories worth examining (use them as a checklist, not a question list):

| Category                  | What to determine                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User intent**           | What problem does this solve? Who is the primary user? What is the success criterion?                                                                                                                                                                                                                                                       |
| **Scope**                 | New page, modification, or backend-only change? Boundaries — what is explicitly out?                                                                                                                                                                                                                                                        |
| **UI/UX**                 | What does the user see and interact with? Existing UI to reference?                                                                                                                                                                                                                                                                         |
| **Data**                  | What data does this need? New tables or existing ones? External API?                                                                                                                                                                                                                                                                        |
| **Architecture**          | What layers does this touch? New module or extend an existing one?                                                                                                                                                                                                                                                                          |
| **Edge cases**            | What happens when X is empty? How should errors display?                                                                                                                                                                                                                                                                                    |
| **Trade-offs**            | Would a simplification be acceptable for v1? If the request is framed as a binary A-or-B choice, is there a middle-ground option?                                                                                                                                                                                                           |
| **Necessity**             | Is this request necessary at all? Could doing nothing, or an existing capability the user has overlooked, serve them just as well? Treat "reject — do nothing" as a legitimate verdict to weigh, not a non-answer; the user invited the feature, but inviting it is not the same as needing it.                                             |
| **Options & exclusivity** | What other options exist beyond the literal request? Of the adjacent features, which are **complementary** (pair well, increase the request's value) and which are **mutually exclusive** — cannot coexist with the request, or conflict with each other, so the user must pick one path? Name both kinds, not just the complementary ones. |
| **Existing patterns**     | Is this similar to an existing feature? Follow the same pattern unless there's a reason to deviate.                                                                                                                                                                                                                                         |

**Caller-supplied ultimate goal.** When the caller (the `/flow-pipeline`
supervisor) hands you an inferred ultimate goal alongside the request, treat it as
a strong prior on the **User intent** signal that anchors the PRD **Problem
Statement** — still validate it against the codebase, and if discovery disagrees,
surface the divergence as an Open Question rather than accepting it blindly.

For deeper techniques, load `<SKILL_DIR>/references/discovery-playbook.md`.

## 4. Architecture Checkpoint

Before drafting the PRD, capture these decisions explicitly (one line each). They
become the "Architecture Decisions" section verbatim:

- **Layers touched:** Which layers does this feature span? (data / domain / UI / integration — adapt to your stack)
- **Domain modules:** Which existing modules are involved? Any new ones needed?
- **Data flow:** Where does data originate, how does it transform, where does it render?
- **New patterns vs. existing:** Does this follow an existing pattern (name it) or
  introduce a new one (justify it)?
- **Binary-framing check:** If the user described the feature as an either/or choice
  (A or B), name at least one intermediate option (a hybrid, a phased rollout, a
  config-gated default) and record the A / middle / B trade-off in the PRD's
  Architecture Decisions or Open Questions section — silently picking a pole violates
  the flow `AGENTS.md` `## Output style` rule **Consider the middle ground when a request is framed as a binary choice.** When the choice is genuinely binary, say so
  explicitly.

Load `<SKILL_DIR>/references/architecture-patterns.md` if you need to verify which
pattern applies.

## 5. Draft the PRD

Synthesize into a structured PRD using `<SKILL_DIR>/templates/prd-template.md` as the
format. Sections:

- **Problem Statement** — what problem this solves and why it matters (not solution language).
- **Scope Boundary** — what's in and what's explicitly out.
- **User Stories / Acceptance Criteria** — testable criteria as "Given/When/Then". Each acceptance criterion must name an externally-failable check — something that can fail without a human looking at it: `a test that runs`, `a file in the expected shape`, or `a command exit code`. "It looks right" is not a check — a criterion a machine cannot falsify provides no regression signal and degrades into manual prose at the `## Test Steps` gate (step 7). This is a strong default, not an absolute MUST: it defers to the genuinely-manual carve-out one stage downstream (subjective UX, cross-browser rendering, performance-under-load criteria are legitimately human-judgment and cannot name an exit code — see the manual-prose carve-out in step 7's automation test), so do not force an author to fake an exit-code check for an irreducibly subjective item.
- **Architecture Decisions** — from the checkpoint above.
- **Technical Constraints** — framework, security, performance needs.
- **Open Questions** — every assumption you made plus anything still unresolved.
- **Recommendation** — a single clear recommendation; see the "Recommendation"
  sub-section below for the verdict enum and one-line-rationale contract.
- **Plan risks** — an always-present single line naming the plan's single weakest
  assumption / biggest risk; see the "Plan risks" sub-section below for the
  always-present/single-line contract.
- **Prompt interpretation** (conditional) — when the prompt names BOTH prescribed
  methods AND a quantitative target; see the "Prompt interpretation (conditional)"
  sub-section below for the full contract.

Load `<SKILL_DIR>/references/example-prd.md` (if present) to match the project's
PRD style.

### Candidate follow-up issues (optional)

If discovery surfaces orthogonal ideas the user did **not** ask for but that the codebase or
the user's verbatim description suggests are worth tracking, capture them as a separate
section that the supervisor will route through `flow-create-issue` post-merge. This is
distinct from "Open Questions": Open Questions are assumptions about _this_ feature that
the user should confirm; candidate follow-up issues are _next-time_ work the user can
opt into.

When (and only when) such ideas exist, add a top-level `# Candidate follow-up issues`
section to `plan.md`, placed between `# PRD` and `# Task breakdown` (see step 8). Each
entry is a single-line markdown checkbox with a title and one-line body, in the form:

```markdown
# Candidate follow-up issues

- [ ] OAuth refresh path leaks tokens — separate concern; needs a dedicated session.
- [ ] `gh-action-cache@v3` is deprecated — pin to v4 in CI.
```

Leave every checkbox **unticked** (`- [ ]`). The supervisor will pop an
`AskUserQuestion` form to let the user pick which to file (1–4 candidates) or fall back to
manual editing (5+ candidates) — on step 4's affirmative branch for feature intents, and
ALSO on the non-feature `advance-to-step-5` path (bug/refactor/docs/infra/chore
pipelines, which skip step 4), so the prompt fires regardless of intent. The user's
selections persist back as `- [x]`; the post-merge sweep at step 10 reads `- [x]` items
and fires `flow-create-issue` for each.

If discovery surfaces no orthogonal ideas, **omit the section entirely** — do not write an
empty heading. An empty heading is a no-op for the supervisor (count is `0` → no form,
no fallback), but it implies candidates exist when none do, adds noise to plan review,
and risks accumulating stale `- [ ]` entries on later edits. The supervisor's
"section absent" and "count is 0" branches behave identically; the value of omitting
the heading is signal-to-noise, not control flow.

Bar for inclusion: is this a _completely separate feature_ — its own user goal and
surface, valuable and shippable on its own? Only then does it belong here. A small or
medium enhancement that serves the requested feature's goal, touches the same surface, or
whose absence would leave the feature partial or awkward is **not** a candidate — it
belongs in the `# Task breakdown`, built now. Per the AGENTS.md `## Output style` rule
**Treat every request as production-bound, not a hobby project.**, the include-vs-defer
test is cohesion, not size; do not use this section as a hedge to defer cohesive in-scope
work. Keep the bar high — backlogs full of low-confidence candidates are noise, and so is
a feature shipped with its cohesive other half parked in a follow-up.

### Recommendation

After weighing the options, the necessity check, and the trade-offs from step 3, commit to
**one** recommendation and record it as a short, always-present `## Recommendation` section
in the PRD. Unlike `# Candidate follow-up issues` and `## Prompt interpretation` — which are
omit-when-empty — a recommendation is always meaningful and cheap, so emit it on every PRD.

The section is a single line: a verdict plus a one-line rationale. The verdict is one of:

- **Proceed** — build the request as scoped.
- **Reconsider scope** — build, but with a named scope change (narrower, wider, or a
  middle-ground option surfaced under the binary-framing check).
- **Defer** — the request is reasonable but better sequenced after other work; name the
  blocker.
- **Reject — do nothing** — the request is not necessary; doing nothing (or pointing the
  user at an existing capability) serves them better. This is a first-class verdict, not a
  failure to plan — when the necessity check (step 3) lands here, say so plainly.

When the verdict is anything other than `Proceed`, the rationale should reference the
relevant Open Question so the user can redirect at the next `plan-pending-review`
checkpoint. The recommendation is advisory — the user always has the final say at the
approval gate.

### Plan risks

After committing to a recommendation, name the plan's single weakest assumption / biggest risk and record it as an always-present `## Plan risks` section in the PRD. This is an adversarial self-critique — "if this plan is wrong, here is the most likely reason" — not a restatement of the Open Questions: Open Questions capture per-feature assumptions the user should confirm, while `## Plan risks` names the one load-bearing assumption whose failure would most likely sink the plan, so the author surfaces it before it ships silently into implementation. Modeled on `## Recommendation`, it is always present, never omit it — a single line, always meaningful and cheap, so emit it on every PRD (unlike `# Candidate follow-up issues` and `## Prompt interpretation`, which are omit-when-empty). The counterpart self-critique site is `new-feature/SKILL.md` Step 2, which closes its Critical Analysis with the same single-weakest-assumption bullet; the two sites cross-link so the discipline is consistent whether the plan originates in discovery or in `/new-feature`.

### Prompt interpretation (conditional)

This is the upstream artifact half of the `## Output style` rule **Treat user prompts as
evidence of intent, not exhaustive specifications.** in `AGENTS.md`. The rule body covers
the _why_ (PR #170 is the canonical precedent — four prescribed trims landed at -71 lines
vs a <800-line target, with no tension surfaced). This sub-section covers the _how_ —
what the discovery subagent must emit so downstream consumers (`/new-feature` Step 2,
`/flow-pipeline` Step 3 routing, `/pr-review` Step 1.5 Gatekeeper) can act on it.

**Trigger.** When the user prompt names BOTH (a) **prescribed methods** — typically a
numbered list, "do X then Y then Z" phrasing, an explicit enumeration of moves to make —
AND (b) a **quantitative target** — a number with units (`<800 lines`, `30% faster`,
`≤ 100ms`, `-N lines`), a coverage percentage, a latency budget — your PRD MUST include
a top-level `## Prompt interpretation` section.

Apply prose judgment for detection (NOT a regex catalogue). Signals worth weighting:
numbered lists (`1. Do X. 2. Do Y. 3. Do Z.`) or explicit enumeration ("the three changes
are…"); a number with units in the same prompt; "make X reach Y" / "reduce X to Y" /
"increase X to Y" framing pairs a method (the verb) with a target (Y). Two signals does
not guarantee tension — sometimes the methods clearly reach the target. The Recommended
path captures that.

**Omit-when-no-tension.** When discovery surfaces neither signal — or only one — omit the
`## Prompt interpretation` section entirely. Same omit-when-empty rule as the
`# Candidate follow-up issues` section above: an empty heading adds noise and risks
downstream consumers treating absent-tension prompts as tension-flagged (the
`/flow-pipeline` Step 3 routing helper exact-matches against the four-value enum below
and a missing heading is treated as "no tension", but an empty heading would be ambiguous
to a human reading the file).

**Section shape.** Three subsections, in this order:

All three are bullets of the form `- **Label:** value` — the label, a colon, and the
value on the **same line**. Emit them exactly that way; the colon-same-line shape is what
the consumer parses (see the Recommended-path bullet below).

- **Reading of prescribed methods:** one of `exhaustive` (the user intends the named
  methods as the complete set) or `starting points` (the user is signalling these are
  minimum moves; you may extend). Anchor on the user's framing — verbs like
  "specifically" / "exactly these" / "only" lean exhaustive; verbs like "for example" /
  "such as" / "to start with" lean starting points; ambiguous framing defaults to
  `starting points` since literal-spec failures (PR #170) are more costly than
  over-eager extensions.

- **Plausibility estimate:** your honest read on whether the named methods can plausibly
  reach the named target. Cite evidence (file sizes, current measurements, existing
  patterns) rather than speculation. When you do not have evidence and cannot easily get
  it, say so — "uncertain — would need to run X to verify".

- **Recommended path:** one of these four strings, copied verbatim — emitted on the SAME
  line as the `**Recommended path:**` label, in the literal one-line form
  `- **Recommended path:** <enum value>`. The `/flow-pipeline` Step 3 routing helper at
  `bin/flow-step3-route.ts` machine-parses this one-line colon form and exact-matches
  against the first string; drift here (a label on its own line, a missing colon, a
  paraphrased value) silently routes runs the wrong way, so emit the value **bare** — no
  surrounding backticks, no bold, no trailing punctuation, on the same line as the colon —
  so the producer here and the consumer (`bin/flow-step3-route.ts`) agree on an exact
  string:
  - `methods plausibly reach target` — the prescribed methods fully cover the stated
    target without extension. No tension; downstream consumers treat the run as if no
    `## Prompt interpretation` section existed (same routing outcome).
  - `extend scope with named additional safe steps` — the prescribed methods leave a
    gap and you can name specific additional steps that close it. Surface those steps
    in the `# Task breakdown` as additional tasks marked as the extension (e.g.
    Task N: "scope extension — covers the gap between prescribed methods and target").
  - `relax target` — the prescribed methods are correct but the target is unreachable
    without scope blow-up (e.g. "<800 lines" requires deleting load-bearing prose).
    Name what you'd cut and why; the user can choose to accept the looser target or
    redirect.
  - `split into multiple pipelines` — the prescribed methods and target together require
    effort that exceeds a single PR (multiple migrations, breaking changes to a public
    API). Name the natural seams; the user can decide whether to file the rest as
    candidate follow-up issues.

**Open-Questions emission rule.** When the Recommended path is NOT
`methods plausibly reach target`, the PRD's `## Open Questions` section MUST include one
user-facing question naming the choice. Example: "Extend scope to add X and Y, or relax
the target to a looser bound?". The question gives the user a single redirect to resolve
the tension at the next `plan-pending-review` checkpoint without re-running discovery.
When the Recommended path IS `methods plausibly reach target`, no Open-Questions entry
is needed (the prompt and the methods are in agreement).

**Single source of truth.** The four enum values and the Open-Questions emission rule
above live in this file ONLY. Downstream consumers — the helper at
`bin/flow-step3-route.ts`, `/new-feature` Step 2 (Critical Analysis), `/pr-review`
Step 1.5 Gatekeeper — reference this file by path rather than duplicating the contract
inline. Drift between this file and a duplicated copy is exactly the silent-failure
mode PR #170 demonstrates; do not inline the enum or anti-pattern list in
`templates/prd-template.md` or in the consumers' SKILL.md files.

## 6. Task Breakdown

Break the PRD into logical, atomic tasks. Each task tagged with the recommended skill.

**Task sizing:** A task is the right size if it touches 1–3 files in one domain area
and can be verified with a single check. Split a task if:

- It spans multiple languages or runtimes (e.g., backend service + frontend client).
- It creates a new DB table AND uses it in domain logic — migration is one task,
  domain model is another.
- It involves both creating a component and writing its tests.

**Dependency ordering** — follow the layer order:

1. Database migration (schema, RLS, triggers, RPCs)
2. Generated DB types
3. Backend proxy handler (if external API)
4. Domain model (entity, DTO, repository)
5. Domain store (reactive state)
6. UI components (pages, components, layouts)
7. Integration wiring (connecting layers, route setup)
8. Tests (unit + integration per layer)

**Format each task as:**

```markdown
### Task N: [Short Title]

- **Skill:** `skill-name`
- **Description:** What to implement
- **Inputs:** What must exist before this task starts
- **Outputs:** What this task produces
- **Acceptance criteria:** How to verify it's done
```

List the skill directory before recommending — do not hardcode a static list.

After the task list, include a **Skills Summary** table showing which skills were
considered and why each was or wasn't recommended:

| Skill    | Recommended? | Reason                              |
| -------- | ------------ | ----------------------------------- |
| database | Yes (Task 1) | New table needed for feature        |
| svelte   | Yes (Task 3) | New page component                  |
| ui       | No           | Existing layout patterns sufficient |
| ...      | ...          | ...                                 |

Include all skills that were plausible candidates — no need to explain why an
obviously irrelevant skill wasn't recommended.

## 7. Draft PR Description

Distill a PR description draft from the PRD. This draft will be used by
implementation skills (like `new-feature`) and validated by `pr-review` — seeding
the description early means the PR tells a coherent story from the start.

**Extract from the PRD into this format:**

````markdown
## Why

<Distill the Problem Statement into 1–3 sentences. Keep the user's pain point and
why it matters — strip solution language. This should read as motivation, not a
feature spec.>

## What

<Convert the Scope Boundary's "In scope" items into a bulleted list of deliverables,
phrased as capabilities or behaviors rather than files or modules. Each bullet
should be verifiable.>

## Key decisions

<Pull from Architecture Decisions and Scope Boundary's "Out of scope". Each bullet:
the decision + a brief rationale. Include scope exclusions that a reviewer might
wonder about.>

## User-facing changes

<Concrete user-observable deltas — phrase in user terms ("you can now run
`flow ls --cost`"), not implementation terms ("added cost column to the ls
renderer"). Each user story's externally observable change becomes a bullet here:
walk the Stories section and, for every story whose acceptance criteria assert
something a user sees or does differently, emit a bullet. Categories to consider:
new CLI commands or subcommands, new flags or changed defaults, renamed/removed
commands, changed prompts or output formats, new env vars, and changed file
locations users interact with.

Format: freeform bullets. For renames or removals, use a `Before → After` bullet so
the delta reads at a glance. Example:

- New flag: `flow ls --cost` adds a `$` column summed across the supervisor session.
- Before → After: `flow install` (removed) → `flow setup` (global install via symlink).

If the PRD describes a pure-internal change (refactor, infra, no user-observable
delta), write the literal word `none` under the heading. Never delete the heading —
`none` is an explicit author affirmation, while a missing heading is ambiguous
between "no change" and "author forgot".>

## Test Steps

<Verification steps for this PR — both automated and manual smoke. The heading is
also the auto-merge gate signal — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the full
contract. The short version: zero unchecked `- [ ]` items ⇒ auto-merge; one or
more ⇒ gated.

Always emit the heading. Decide the body based on the PRD:

- If the PRD describes a pure-internal change (refactor, infra, doc fix,
  generated-code regen) with no user-observable delta — leave the section empty
  under just the placeholder HTML comment. The rubric strips HTML comments before
  counting, so zero unchecked items ⇒ auto-merge.
- Otherwise — populate with `- [ ]` items derived from the acceptance criteria in
  User Stories, applying the **automation test** from
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Automate first"
  section) to each candidate item _before_ you write it. The test:

  > Can I name (a) a fixture / setup, (b) one or more deterministic assertions, and
  > (c) an exit condition — all without subjective human judgment? If yes, this is
  > a runnable item, not manual prose.

  When the answer is yes, write the item as the deterministic shell command itself
  (`npm run test -- <file>`, `bun bin/<helper>.test.ts`, `gh pr view <n> --json …
--jq …`, `test -f <path>`, `grep -q <pattern> <file>`,
  `[ "$(cat <path>)" = "<expected>" ]`) so `/pr-review` Step 8c can run it and tick
  the box. Manual prose survives only when the rubric flags the scenario as genuinely
  manual (subjective UX, production-only integrations, cross-browser rendering,
  performance under realistic load). A step whose only unmet preconditions are
  `local and reversible` (start the dev server, bring up / seed the local DB, set a
  local `.env` var, drive a headless browser) is `locally satisfiable` — write it as
  the runnable setup-plus-assertion (perform the setup, then assert), NOT pre-labeled
  "manual — needs the local stack"; see
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Genuinely manual")
  for the boundary. Use as many items as the change warrants — don't pad to look
  thorough and don't truncate to look concise.

  When the PRD describes **multiple distinct user-facing behaviors** (several facets,
  commands, or states), emit at least one end-user functional check per distinct change —
  not a single representative step that conflates them — so the checklist shows the full
  scope of new behavior and no facet can break silently because nothing asserted it. This
  is the breadth axis, orthogonal to the happy/unhappy/edge depth categories; each facet
  still routes through the automation test above (automate where automatable, manual only
  where genuinely manual — it is not a mandate to add manual prose). See
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Coverage breadth") for the
  requirement and a worked multi-facet example.

  For a non-trivial UI appearance change, author one `SUBJECTIVE: `-prefixed `- [ ]` Test
  Step per distinct UI facet (layout, animation, empty state, color/theme) that the agent
  can never tick on the user's behalf — a brand-new page built only from auto-tickable
  visual-appearance assertions would otherwise auto-merge with no aesthetic sign-off. Trivial
  tweaks (copy fix, padding nudge, icon swap) are exempt. Defer to
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Subjective checks") for the
  full contract, the include-vs-exempt test, and a worked example — do not inline the rule body.

  Before writing any item as a browser-manual step, apply the layered-decomposition check:
  route a backend/API contract to a deterministic integration test, reserve the browser tier
  for assertions only a browser can make, and split a step that bundles the two — pushing each
  assertion to its lowest faithful layer. See
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Decompose a manual step by layer")
  for the rule and the econ-data #370 worked example.

  For whatever stays manual, spell out the exact how for every precondition the step states —
  name the command, click path, or setting that satisfies it, assuming no prior knowledge of
  project-specific toggles or jargon, and never a bare "turn X on" / "with X enabled" without
  the concrete steps. See
  `skills/pipeline/pr-review/references/manual-test-rubric.md` ("Precondition concreteness")
  for the rule and a before/after example.

Open the `## Test Steps` section with this HTML comment, copied verbatim, between
the heading and the first `- [ ]` item. The auto-merge gate strips HTML comments
before counting so the marker is invisible to the count, and any later editor (an
agent re-running pr-review, a human pasting in steps) sees the same standard:

```html
<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/pr-review/references/manual-test-rubric.md. -->
```
````

Example (auto-merge — empty section):

<!-- No human verification needed — pure-internal change. -->

Example (gated — non-empty section, marker preserved):

<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/pr-review/references/manual-test-rubric.md. -->

- [ ] Run `npm run test -- <test-file>` — all specs pass.
- [ ] Run `[ -f <path> ] && grep -q "<expected>" <path>` — config is wired.
- [ ] SUBJECTIVE: you approve the overall look and feel of the new <route> page

````

**Rules:**

- The PR description is a **distillation**, not a copy. Do not paste PRD sections
  verbatim.
- "Why" must not contain solution language. If you catch yourself writing
  "by adding X" or "through implementing Y", rewrite to focus on the problem.
- "What" bullets should each be testable against the implementation. Avoid vague
  bullets like "improve the user experience".
- "Key decisions" should only include decisions where a reasonable alternative
  existed. Don't list obvious choices.
- "User-facing changes" must be phrased in user terms (what someone running the
  tool will see or do differently), not implementation terms. If the PRD has no
  user-observable delta, write `none` under the heading — never omit the heading
  itself.
- Always emit the `## Test Steps` heading, even for refactors. The auto-merge gate
  treats a missing heading as an upstream regression and escalates `NEEDS HUMAN`.
  Zero unchecked items under the heading is the auto-merge state; one or more
  unchecked `- [ ]` items is the gate state.
- Render every "Test Steps" entry as a `- [ ]` markdown checkbox so reviewers can
  tick items off as they verify and the auto-merge gate can count them.
- Do not hard-wrap prose at a fixed column width. Write each paragraph as a single
  line and let the renderer wrap it. Hard wraps go ragged the moment a sentence
  is edited and add no value on GitHub, which renders one long line as one
  flowing paragraph.
- Save the draft to the `pr-description-draft.md` absolute path the wrapper passed
  you. Create the parent `.flow-tmp/` directory first with `mkdir -p` if it
  doesn't already exist — `/flow-pipeline` worktrees pre-register the path in
  `.git/info/exclude` so it stays untracked, and a stray write at the worktree
  root would block the post-merge `git worktree remove` in `/flow-pipeline`
  step 10.

## 8. Persist the consolidated plan

Write the full PRD + task breakdown + PR-description draft to the `plan.md`
absolute path the wrapper passed you. Create the parent `.flow-tmp/` directory
first with `mkdir -p` if it doesn't already exist. Single artifact, sections
in this order:

```markdown
# PRD

<the structured PRD from step 5>

# Candidate follow-up issues

<optional — only when discovery surfaced orthogonal ideas; see step 5's
"Candidate follow-up issues" sub-section. Omit the heading entirely when
empty>

# Task breakdown

<the ordered tasks + Skills Summary from step 6>

# PR description draft

<the Why / What / Key decisions / User-facing changes / Test Steps from step 7>
````

This file is the predictable handoff for the `/flow-pipeline` supervisor — it
reads `.flow-tmp/plan.md` after the wrapper returns to drive the implement phase.
When `/product-planning` is run manually (no supervisor), the same file is still
useful as a single artifact the user can share or iterate on. Overwrite any prior
`.flow-tmp/plan.md`; do not append.

The path lives under `.flow-tmp/` (rather than the worktree root) so the
post-merge `git worktree remove` in `/flow-pipeline` step 10 doesn't choke on a
stray untracked file. `flow-new-worktree` registers the path in
`.git/info/exclude`, and `flow-remove-worktree` cleans the directory before
removing the worktree.

The `pr-description-draft.md` write from step 7 is independent and stays — it's
the artifact `pr-review` consumes. Both files should land.

## 9. Return a brief summary

Your final message back to the wrapper should be one short paragraph (3–5
sentences max): the problem statement in one line, the number of tasks, the
candidate follow-up issue count if non-zero (e.g. "3 candidate follow-up
issues for the user to pick from"), and the top one or two open questions
or assumptions the user should pay attention to. **When Step 1.5's research
path was active but no research ran, also append the one-line skip-note from
(e)** (e.g. "Web-grounded research skipped — agy unavailable; force with
`flow new --research`.") so it reaches chat; stay silent when the path was
fully dormant. Do not paste the PRD or task list back — the wrapper only forwards your summary to the caller, and
the artifacts on disk are the durable record. Keeping the return value
short is the whole point of the subagent fan-out.

# Troubleshooting

Common failure modes during planning:

| Problem                | Symptom                                             | Fix                                                                                |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Scope creep            | Tasks keep growing; PRD has 20+ acceptance criteria | Split into v1/v2 milestones; ask "Is this essential for launch?"                   |
| Ambiguous requirements | Multiple valid interpretations of a user story      | Pick the most defensible interpretation; surface the alternative in Open Questions |
| Missing constraints    | Plan proposes patterns that conflict with AGENTS.md | Re-read `AGENTS.md` before finalizing; cross-reference security and style rules    |
| Stale skill references | Recommended skill doesn't exist                     | Always list the skill directory before recommending — never assume                 |
| Over-planning          | Trivial change forced through full PRD              | Re-check the Scope Check (step 2) — if ≤ 3 tasks, use the lightweight flow         |
| Skill mismatch         | Task recommends a skill that doesn't fit the work   | Re-read the skill's "When to Use" / "When NOT to Use" before assigning             |

# Verification

- PRD contains all sections (Problem, Scope Boundary, Stories, Architecture,
  Constraints, Open Questions).
- Every user story has testable acceptance criteria (not vague "works correctly").
- Architecture Decisions section names specific layers, domain modules, and data
  flow pattern.
- Every assumption you made under ambiguity appears as an Open Question.
- Task breakdown covers all PRD requirements with no gaps.
- Each task has a recommended skill, inputs, outputs, and acceptance criteria.
- Tasks are ordered by dependency (no task references an output that hasn't been
  produced yet).
- No task is too large for a single focused session (if it seems large, split it).
- Skill recommendations reference skills that actually exist in the project's
  skill directory.
- PR description draft follows the standardized format (Why / What / Key
  decisions / User-facing changes / Test Steps).
- Both `.flow-tmp/plan.md` and `.flow-tmp/pr-description-draft.md` were written
  at the absolute paths the wrapper passed you, with parent directory created on
  demand.
- `# Candidate follow-up issues` section is omitted from `plan.md` when discovery
  surfaced no orthogonal ideas; populated as one or more `- [ ]` items otherwise
  (never written as an empty heading).

# Constraints

- NEVER write application code — your sole output is strategy, the two artifact
  files, and a brief return summary.
- NEVER ask the user clarifying questions — the Task tool is one-shot. Make
  informed assumptions and surface them as Open Questions.
- NEVER hardcode the skill list — always read the skill directory to get the
  current set.
- NEVER skip loading `README.md` (or the project's primary architecture doc) —
  your assumptions must be informed by existing architecture.
- NEVER dump the full PRD into the PR description — distill problem, scope, and
  decisions only.
- NEVER paste the PRD or task list back to the wrapper as your return value —
  the artifacts on disk are the record, the return summary is one short
  paragraph.
