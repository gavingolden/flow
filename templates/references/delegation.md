### Google-AI delegation via headless Antigravity (optional)

`flow-delegate` is an optional helper that offloads a single prompt to a
**headless Antigravity (`agy`) session** running on your **Google AI Ultra
subscription quota**, writing the model's output to
`.flow-tmp/delegate-<task>.md`. It exists for **cost-arbitrage** — spend idle
Ultra quota on research / heavy reasoning instead of Claude subscription
credits.

Onboarding is one step: install the Antigravity CLI (`agy`) and log in once via
Google OAuth with your Ultra account (`agy` caches the session in your OS
keyring). No API key is needed — a local OAuth login draws the subscription
quota. When `agy` is absent or logged out, `flow-delegate` exits 0 with
`{ran:false,skipReason}`, so a pipeline that hasn't configured it proceeds and
never hard-fails — the same opt-in-by-presence model as UI validation in
`rules/ui-validation.md`.

Usage: `flow-delegate (--prompt "<text>" | --prompt-file <path>) [--model
"Gemini 3.1 Pro (High)"] [--timeout 5m] [--skip-permissions] [--add-dir
<dir>]... [--out <path>] [--task <name>]`. Pass exactly one prompt source
(`--prompt` for inline text, `--prompt-file` for a path — also the escape hatch
for a prompt that literally begins with `--`). Omit `--model` to use your agy
session default; pass a Gemini variant for model diversity. `--skip-permissions`
opts a tool-using run into non-interactive auto-approval, `--add-dir` scopes
extra workspace dirs, and `--task` names the artifact
(`.flow-tmp/delegate-<task>.md`). See the `bin/flow-delegate.ts` header docstring
for the full per-flag contract. It is a standalone leaf helper — flow does not
auto-invoke it from any pipeline step. Every delegated prompt is unconditionally
prefixed with a read-only-first operating-constraints preamble (no writes, no
mutating git, no installs/builds/tests) before it reaches `agy`, regardless of
what the caller's prompt text says.

**Optional `research.discovery` opt-in (planning research pre-check).** Setting
`{ "research": { "discovery": true } }` in `~/.flow/config.json` lets a pipeline
OPTIONALLY run deep, web-grounded, agy-delegated research **before planning**,
feeding a cited report into discovery as prior context (with confidence labels).
It is **config-only** — there is no `flow feature create` flag — and the schema is an object
(`research: { discovery: boolean, maxCalls?: number, model?: string, refuteModel?: string, timeout?: string }`,
`discovery` default `false`). The pass is **relevance-gated and safe-by-default**:
it fires only on a genuinely-researchable feature (integrating an external
API/spec, a security/correctness question with an authoritative answer, a "current
best practice for X" question) and skips a pure-internal change (CSS tweak, rename,
refactor); when uncertain it does not research. When `agy` is absent or logged out
it **gracefully skips** (a no-op — planning proceeds unchanged, never hard-fails),
the same opt-in-by-presence model as `flow-delegate` itself.

Four optional **budget keys** tune the bounded pass; each defaults to its v1 value when absent:

- `research.maxCalls` (number, default `12`) — the `flow-delegate-fanout --max-calls` cap on total agy calls.
- `research.timeout` (string, default `"3m"`) — the per-manifest-entry agy timeout, applied to every entry.
- `research.model` (string, default `"Gemini 3.1 Pro (High)"`) — the **gather** model variant.
- `research.refuteModel` (string, default `"Claude Opus 4.6 (Thinking)"`) — the adversarial **refute** model variant. It must stay a _different_ variant from `research.model`; if you set both equal, flow warns and falls back the refute to a pinned alternate (`"Claude Opus 4.6 (Thinking)"` / `"GPT-OSS 120B (Medium)"`) that differs.

Each key is **tolerant by construction**: an absent key silently takes its default; a key that is **present but the wrong JSON type triggers a loud `stderr` warning and falls back to the default** — never a throw, never an aborted pass, so a config typo degrades to a warning rather than blocking planning. `--concurrency` is **not** operator-tunable (pinned at `4`; it is load-bearing in the runtime-ceiling arithmetic). The pass stays **bounded** — the synchronous worst case is `ceil(maxCalls / 4)` waves × the per-entry timeout, ~9-min at the defaults (`3` waves × `3m`). **Runtime-ceiling caveat:** raising `maxCalls` and `timeout` together can push that product past the observed-safe ~10-min one-shot sub-agent wall-clock, so keep it under ~10 min when tuning. Off by default; absent or malformed config behaves exactly as today.

**Optional `review.gemini` opt-in (cross-model PR reviewer).** Setting
`{ "review": { "gemini": true } }` in `~/.flow/config.json` adds ONE additional
cross-model reviewer (Gemini, via agy on your Google AI Ultra quota) to
`/flow-pr-review`'s multi-agent review, alongside the existing six content-gated
Claude lenses plus a seventh, brief-gated product lens.
`/flow-pr-review`'s Claude lenses all run on the same Claude model family and
share that family's blind spots; a genuinely different model catches issues no
role-specialized Claude lens does, at no Claude-credit cost. It is **config-only**
(no `flow feature create` flag), the schema is an object (`review: { gemini: boolean }`,
default `false`) so per-lens-focus knobs can be added later without a break, and
the gate is read tolerantly:

```bash
jq -e '(.review | type == "object") and (.review.gemini == true)' ~/.flow/config.json
```

(strict boolean `true` enables; absent/malformed/non-`true` disables). The lens
is **purely additive and safe-by-default**: it requires an authenticated agy /
Google AI Ultra session and **gracefully skips** when `agy` is absent or logged
out (the other Claude lenses run unchanged — it never hard-fails the review), the
same opt-in-by-presence model as `flow-delegate` itself. Malformed or
non-conformant Gemini output is dropped with a recorded skip reason rather than
breaking the review. Off by default; absent or malformed config behaves exactly
as today.

The **same** `review.gemini` key ALSO gates a Layer-2 **cross-model plan review**
in `/flow-pipeline` Step 3 (no new config key — someone who wants a cross-model
reviewer at PR time wants one at plan time too). When it is opted in and the PRD
carries an omit-when-empty `## Decision analysis` section, the supervisor runs one
AGY (`flow-delegate`) review of the plan's consequential decisions, reads the
feedback, and revises the PRD once if warranted. It reuses the same tolerant jq
gate shown above, the AGY model is hardcoded (`Gemini 3.1 Pro (High)`, no override
key), and it is the same graceful no-op when agy is absent — a `ran:false` skip
that never blocks the plan gate.

### Product brief (`.flow/product.md`, optional)

A repo may carry a committed `.flow/product.md` — a short, human-legible
statement of what this repo's product manager optimizes for. It is not a
roadmap and not a spec: it records the standing priorities that every plan,
plan review, and explanation should be weighed against, so those decisions
stop falling back to generic engineering defaults.

Five sections, in this order: **Who the PM is** (a real person or role, not a
persona), **Ranked priorities** (an explicit ordering — user experience, cost,
architecture, product quality, whatever this product actually trades off),
**What "good" looks like**, **Non-goals**, and **Vocabulary** (words to use
and words to avoid).

Conventions the agent follows (and a human editor should too):

- **Human-maintained, committed.** Unlike the design foundation, the agent
  does not write this file — it reads it. You own the priorities.
- **Repo first, then user.** `.flow/product.md` in this repo wins; otherwise
  `~/.flow/product.md` applies to every repo you own. No config key, no
  environment override.
- **Read it with `flow-product-brief`.** The helper prints one JSON line
  (`{"found":true,"scope":"repo"|"user","path":"<abs>","text":"<contents>"}`
  or `{"found":false}`) and always exits 0, so nothing needs a guard.
- **No secrets, ever.** The file is committed and its full text is sent
  verbatim to an external cross-model reviewer.
- **Keep it short.** The text is quoted into prompts; it is capped at 4000
  characters, and a brief that has to be truncated is one nobody is reading
  either.
- **Absent is normal.** With no brief in the repo and none in your home
  directory, flow behaves exactly as it does without this feature — the
  plan-review prompt is byte-identical and discovery changes nothing.
  Deleting the file degrades the same way.
