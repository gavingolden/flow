# Browser-driven UI-smoke pass (gate-time)

The shared procedure behind the gate-time UI-smoke pass that both `/flow-pipeline` Step 6 (the supervisor-side "Automated UI-smoke pass") and `/flow-verify`'s "Optional UI-smoke pass" run. Both consumers keep a short pointer and their own framing (the supervisor's 3-attempt fix loop; `/flow-verify`'s "alongside `flow-pre-commit`" + Step 3 routing); the full probe → fallback → launch → drive-MCP → assemble → fix-loop → noise-filter → persist-back body lives here so the two cannot drift. This is the gate-time smoke pass; the review-time visual-appearance evidence path is a separate procedure documented in `../../flow-pr-review/references/ui-validation-evidence.md`.

## Caller contract: who runs this body

This file documents the drive procedure itself. WHO executes it —
`/flow-verify` inline in its own context, or the spawned `flow-ui-driver`
Task-tool exemption (`references/exemption-contracts.md`'s `/flow-verify`
Independent UI-Driver Subagent) — is the caller's decision, made once per
outer `/flow-verify` attempt:

1. **Probe and get a verdict.** The caller runs the "Probe and skip (and
   bootstrap)" step below itself (never inside a spawned agent — the
   verdict decides whether to spawn at all) and saves the resulting
   envelope to `.flow-tmp/ui-driver-envelope.json`.
2. **Branch on the verdict.** An `mcp-not-available` / `browser-profile-busy`
   skip never spawns anything — relay the loud skip and move on. A
   `ran:true` (ready) or `bootstrap` envelope is drivable.
3. **Spawn, unless marked inline.** On a drivable envelope, spawn one
   `flow-ui-driver` agent (passing the saved envelope path) to run "Launch
   and drive" through "Self-improving manifest" below in its own isolated
   context — UNLESS the invocation carries the literal marker
   `UI_SMOKE_DRIVER: inline` (the `/flow-fix-applier-instructions` re-run
   path, which has no Task tool of its own), in which case `/flow-verify`
   drives the same procedure in its OWN context instead. See "Where the
   MCP calls live" below.
4. **Read the artifact once.** Whichever path drove it, read
   `.flow-tmp/ui-driver-result.json` once via
   `flow-ui-driver-schema --validate` and reuse the parsed object — never
   re-read or re-derive it later in the same attempt.
5. **Route `ok:false` through the fix loop; degrade a missing artifact.**
   An `ok:false` result is a verify failure per "Fix-loop routing" below.
   A missing/unwritable artifact after a spawn returns degrades to
   `skipped_reason: driver-no-artifact` — never an escalation, never a
   re-spawn within the same outer attempt (see
   `references/exemption-contracts.md`'s degrade contract).
6. **Surface the skip/reason line.** Whatever the outcome, relay the
   user-visible "UI changed; browser validation did not run — <reason>"
   line per "When it runs" and "Probe and skip" below. For
   `skipped_reason: app-launch-failed`, use the cause the driver quoted in its
   `summary` as the `<reason>` (so an older-install "run flow install
   --upgrade" hint reaches the user), not the bare reason code.

## When it runs

When the diff touches a meaningful UI surface AND the `chrome-devtools` MCP is available in the session, run the browser-driven UI-smoke pass as part of the verify gate — a hand-authored `.flow/ui-validation.json` manifest is no longer a precondition. The `chrome-devtools` MCP is resolved once at session start, so a UI diff that appears mid-session without the MCP already connected stays not-runnable. Headless / MCP-absent runs stay green — the pass is an additive live check, never a blocker on environments that can't drive a browser. On a run that does drive the browser, the per-route/per-viewport screenshot is a first-class required capture alongside the a11y snapshot: every screenshot path that lands on disk is recorded into the verify-loop artifact's `ui_screenshots[]` so the supervisor can surface each one as a clickable absolute path in the session (see "Launch and drive" below). The a11y snapshot stays the mechanical gate — a missing or unwritable screenshot is never a new merge-block.

## Probe and skip (and bootstrap)

Probe for the MCP first with a guarded `ToolSearch query="select:mcp__chrome-devtools__navigate_page"`. On missing schema, fall back to `flow-ui-validate --mcp-absent --manifest .flow/ui-validation.json` — a quiet `ran:false` / `skipped_reason: mcp-not-available` skip that never blocks the run, exactly mirroring `flow-pre-commit`'s optional-tool `skipReason` (the `actionlint` / `go` off-PATH skips). Otherwise run `flow-ui-validate --manifest .flow/ui-validation.json --changed-files <git diff --name-only HEAD>` and **branch on the helper verdict, never on your own prose** — the mechanical fire-decision is the whole point.

- **`action: "bootstrap"`** (no valid manifest yet, meaningful UI diff, MCP present): the helper has deterministically inferred `launch`/`baseUrl` (with the `{{PORT}}` placeholder), `routes`, `loginUrl`, and credential env-var NAMES, plus a `needs[]` of what it couldn't infer. The bootstrap verdict already carries a resolved `meta.launch`/`meta.baseUrl` (the `{{PORT}}` placeholder replaced by a freshly allocated port), so **empirically verify** the inference: bring the launch up with the same `--from-envelope` call as **Launch and drive** below (the bootstrap launch is a real dev server and gets a registry row like any other). If the inferred launch needs adapting (e.g. the dev server ignores `PORT`), write the adapted launch (still with `{{PORT}}`) into `.flow/ui-validation.json`, re-run `flow-ui-validate --manifest .flow/ui-validation.json`, save its verdict to the envelope path, and repeat the same `--from-envelope` call; when the bootstrap verdict carries no `meta` (port allocation failed), record `app-launch-failed` rather than substituting a port by hand, drive the derived routes, and (when a `loginUrl` is present) check presence with `flow-ui-login check` (names only; never read `.env` yourself) and log in via the Login step in **Launch and drive** below. On success, write the verified NAMES/config back into `.flow/ui-validation.json` — storing names and non-secret config only — never a secret value — and commit it into the reviewable PR diff, then proceed with the assemble step as if a manifest had always existed. When `needs` includes `credentials` (a login wall exists but no credential NAMES could be mined and none resolve from the local env), write everything else you verified into the manifest, commit it, and escalate `NEEDS HUMAN: smoketest-needs-creds` (autonomous path) rather than guessing a login flow.
- **`ran: true` (ready)**: a valid manifest already exists — drive it directly (below). When the manifest declares `dependsOn`, first run `flow-ui-preflight --worktree "$WORKTREE"` (Bash `timeout: 600000`) — it probes each declared service with a load-aware backoff and runs a declared `start` once; its envelope (`.flow-tmp/ui-preflight.json`) is the readiness verdict, and no ad-hoc probe (`curl`, a port check) ever vetoes the drive. On `ready: false` take the quiet `dependency-unready` skip (`ran: false`) instead of launching a doomed app. A down dependency is cheapest to start here, at verify, before review needs it. A manifest with no `dependsOn` skips the call.
- **`ran: false` skip**: relay the loud `nudge` when `loud:true` (a broken-precondition hint, or the quiet not-meaningful skip for a bare stylesheet with no derivable route) and proceed — the rest of the diff still verifies. Whenever a UI diff went unverified this way, record the reason so the supervisor surfaces the user-visible "UI changed; browser validation did not run — <reason>" line (see the `ui_smoke` reason carrier). The same reason carrier also covers the case where the browser DID render but every screenshot save path was denied — reason `screenshots-unwritable` — which likewise never blocks the run; it is a surfaced gap, not a failure.

## Launch and drive

On a `ran:true` ready envelope, launch the app as one standalone foreground Bash call: `flow-spawn --detach --class default --stdout <WORKTREE>/.flow-tmp/ui-launch.out --stderr <WORKTREE>/.flow-tmp/ui-launch.err --slug <SLUG> --cwd <WORKTREE> --from-envelope <ENVELOPE_PATH>`, with every placeholder written as a literal absolute path or the slug — never a shell variable, `cd … &&`, an env-var prefix, `&`/`nohup`, or a chained probe. The helper reads `meta.launch` and `meta.env` from the verdict file itself, so there is no launch string for you to quote or re-type, and a launch that starts frontend+backend on dedicated ports is still that one call. It applies `meta.env` to the launch process only (env vars, never written to a `.env.local`/`.env`/config file, per the inline-only rule below). It prints the launched pid, which is also the process-group id used at teardown. If `flow-spawn` refuses the call with the literal stderr `flow-spawn: unknown flag: --cwd` or `unknown flag: --from-envelope` (an older install that predates these flags), record `skipped_reason: "app-launch-failed"` with the cause "flow-spawn too old — run flow install --upgrade" in the summary; any other `flow-spawn: --from-envelope: …` refusal (e.g. `envelope has no meta object`, an unresolved `{{PORT}}`) records `app-launch-failed` quoting that message verbatim as the cause. A permission-system denial of the launch is the same `app-launch-failed`, with the cause `launch denied by auto mode`. Either way, never improvise another launch form — and put the cause in the summary, because step 6 relays it as the `<reason>` of the user-visible skip line. Then open a per-pipeline isolated page first (`new_page` with an `isolatedContext` named from the pipeline slug — read `FLOW_SLUG` / `~/.flow/state/<slug>.json` / the worktree basename — so two pipelines sharing one chrome-devtools MCP server do not bleed cookies/storage). **Login step (auth-gated apps).** Canonical recipe: [../../flow-pr-review/references/ui-validation-evidence.md](../../flow-pr-review/references/ui-validation-evidence.md) “## Login step (auth-gated apps)” — helper-based: `flow-ui-login check` (names only) → `flow-ui-login test-account` (prints the seeded local test account's two values) → load `mcp__chrome-devtools__fill_form` with `ToolSearch` if deferred → `navigate_page` to `loginUrl` → a transient `take_snapshot` (mandatory for the element `uid`s, never saved; never snapshot again while still on `loginUrl` after filling) → ONE `fill_form` with the two values, then click submit → `wait_for` the redirect, `loginOk` from `location.pathname`. Run `check` and `test-account` each as its own standalone foreground Bash call (absolute `--manifest`/`--worktree` paths, no `cd … &&`, no env-var prefix, no `&`/`nohup`, no redirect, no pipe or output filter). `test-account` reads only the committed, unmodified `.flow/ui-validation.json`, so a bootstrap must commit the manifest before logging in (exit 2 `manifest-not-committed` / `manifest-not-in-worktree` otherwise). Exit 2 `non-local-base-url` means the manifest points off localhost: record `login-failed` naming the non-local address (`baseUrl` or `loginUrl`). Never write the values anywhere (captures JSON, result artifact, manifest, commit, PR body, Test Step) and never screenshot the login form. A refusal of any credential action (reading a `.env`-family file, printing a credential variable, running `flow-ui-login test-account`, or the `fill_form` that types the values) means stop: record `skipped_reason: "credentials-unavailable"` per the `<!-- flow-credential-denial-rule -->` there, never retrying through another tool. Values filled and submitted but still on `loginUrl` is `login-failed`. Let the caller surface `NEEDS HUMAN: smoketest-needs-creds` for the credential-denial case. Then drive the MCP per route, and **inside each route, loop over `meta.viewports`** (the envelope carries the declared set or the built-in default `xs 320 / mobile 390 / tablet 768 / desktop 1280 / wide 1440`): for each viewport call `emulate` ONCE with `viewport: "<width>x<height>x1"` (the declared `height`, else a tall default of 2000 — so above-the-fold cropping never hides overflow; append `,mobile,touch` below 768 wide), `colorScheme: "light"`, and `prefersReducedMotion: "reduce"` when `manifest.disableAnimations` (an enum value, never a boolean) — each `emulate` call replaces every earlier emulation setting, so restate all of them every time → the existing per-route `navigate_page` → `wait_for` → `take_snapshot` → `list_console_messages` → `list_network_requests` drive (from it, record per viewport `rateLimited: [{url, count}]`: each URL answered HTTP 429 and how many times that URL was requested on the route, at most 10) (reduced motion is already set by the `emulate` call) → `evaluate_script` reading `document.scrollingElement.scrollWidth` / `clientWidth` and the page-root constrained container's `getBoundingClientRect()` left/right gaps (`rootGap: {left, right}`) → `take_screenshot` (filename includes the viewport name, e.g. `0-wide.png`) → AFTER that screenshot (the probe scrolls the page), at viewport widths 320, 390 and 1280 only (chosen by width, never by name — consumer manifests name their own viewports; 768 and 1440 keep the geometry rules alone), `evaluate_script` the output of `flow-ui-validate --probe-script` (fetch it once per drive and reuse it) and store the returned object as that viewport's `heuristics` plus `innerWidth` (`window.innerWidth`). When any viewport's probe reports `hasDarkScheme`, add one more viewport named `desktop-dark` (1280 wide, `colorScheme: "dark"`; when `darkSchemeClass` is set, first add that class or attribute to `document.documentElement` through `evaluate_script`) and run the same drive and probe for it, recording `colorScheme: "dark"` on that capture. Write the enriched per-viewport captures JSON — the top level states `launchOk` and `loginOk` explicitly (`true` or `false`; an absent field reads as "not reported", never as a pass), and each route gains a `viewports[]` array of `{ name, width, innerWidth, colorScheme, heuristics, rateLimited, snapshotText, consoleErrors, failedRequests, screenshotPath, rootGap, scrollWidth, clientWidth }` — and call `flow-ui-validate --manifest .flow/ui-validation.json --captures <path>`; tear the launched server(s) down on completion. The helper applies the three mechanical geometry assertions (off-center, horizontal overflow, missing-element-at-breakpoint) and judges each viewport's `heuristics` (page-quality defects and advisory smells) from those raw NUMBERS — it never drives the MCP and never reads the DOM (the no-nested-LLM split below). A `viewport-mismatch` or `dark-scheme-not-applied` env skip in its output is a loud skip line in the report, never a `fix_context` entry. Screenshot capture follows the save-path cascade documented in `/flow-pr-review` Step 8c (worktree `.flow-tmp/ui-evidence/` preferred → session-cwd fallback → skip-with-loud-note). Every path the cascade successfully writes is required evidence recorded into `ui_screenshots[]`; the a11y snapshot remains the sole mechanical gate, so a cascade that lands on skip-with-loud-note (`screenshots-unwritable`) surfaces the gap in-session but never fails the pass or blocks the merge.

When the committed manifest carries a `{{PORT}}` sentinel — or one or more `{{PORT_<NAME>}}` named sentinels (e.g. `{{PORT_BACKEND}}` for a two-process launch) — in `launch`/`baseUrl`/`env`, the ready envelope already has each distinct sentinel resolved to its own freshly-allocated per-run free port before you ever see it: `meta.port` records the bare sentinel's resolved number, `meta.ports` (keyed by name, e.g. `meta.ports.BACKEND`) records every named sentinel's resolved number — so drive `meta.launch`/`meta.baseUrl`/`meta.env` verbatim and never re-resolve any sentinel yourself; two concurrent pipelines, and two distinct processes within the same pipeline, each get their own distinct port this way. A manifest with a literal port everywhere carries no `meta.port`/`meta.ports` and is used as-is, unchanged from before.

**Port and URL overrides are passed INLINE to the launch subprocess (env vars / CLI flags) and are NEVER written to `.env.local`, `.env`, or any other file.** A file-based override is gitignored, outlives this run, and silently re-points a later manual `npm run dev` at a stale port. If the manifest can't express a need, extend the manifest itself (an `env` entry, a new `{{PORT_<NAME>}}` sentinel) — never write a config file to work around a gap.

**Container-selection heuristic (page-root constrained container).** The element whose `rootGap` you pass is the outermost element under `<main>` (or `<body>` when there is no `<main>`) whose computed width is _less than_ the viewport width — i.e. a deliberately constrained column. Measure its `getBoundingClientRect()` and pass `rootGap.left` / `rootGap.right` as the distances from the viewport edges. A full-bleed element (width equal to the viewport) has no meaningful gap, so it is not the constrained container; skip it. The per-viewport "UI traits to verify" rubric — authored canonically in [../../flow-pr-review/references/ui-validation-evidence.md](../../flow-pr-review/references/ui-validation-evidence.md) under `## UI traits to verify` — is applied **per captured viewport** alongside these mechanical assertions.

**Shared-profile lock (parallel pipelines).** chrome-devtools-mcp backs every browser with a single default on-disk Chrome profile (`~/.cache/chrome-devtools-mcp/chrome-profile`), so two pipelines that both reach this pass under one un-isolated MCP registration contend for it — the second to launch errors with `The browser is already running for ~/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances`. On detecting the lock, drive `flow-ui-validate --browser-busy` — a loud-but-clean `ran:false` / `skipped_reason: browser-profile-busy` skip that degrades exactly like an absent MCP, never a hard failure. The cross-process fix is operator-side: register the chrome-devtools MCP with `--isolated` in `~/.claude.json` so each server process gets its own auto-cleaned throwaway profile. The per-call `isolatedContext` above is same-server defense-in-depth only — it isolates pages within one MCP server but does NOT resolve the cross-process on-disk-profile lock.

## Item-driven drive

**Gate: this section applies only when the spawn prompt carries `MODE: items`** (alias: `MODE: visual-appearance`) — the `/flow-pr-review` Step 8c.iii caller. The gate-time smoke pass above never uses it. The caller passes a checklist item list with each item tagged by kind; the driver works each item in list order inside the same launch, the same per-pipeline `isolatedContext`, and the same teardown as the smoke pass — still exactly one UI-Driver spawn per review pass. Results land in the artifact's optional `item_results[]` (`bin/lib/ui-driver-schema.ts`), one entry per item, each echoing the `index` the caller listed. Whichever caller spawned the driver, the artifact carries `headSha` (`git rev-parse HEAD`, computed immediately before the write) and the `caller` the spawn prompt named — `verify` for the `/flow-verify` smoke pass (which never lists items), `review-8c` for Step 8c.iii — so `flow-gate-decide` ignores a verify-stage artifact and any file from an older head.

| Kind         | Source item                                              | What the driver does                                                                  | Verdicts                         |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| `appearance` | an enumerated visual-appearance assertion                | navigate, `wait_for`, `take_snapshot`, assert the observation against the snapshot    | `pass` / `fail` / `not-drivable` |
| `behavior`   | a `Browser: on <route>, <action> — expect <result>` item | perform the action chain, `wait_for` the expected result, `take_snapshot` as proof    | `pass` / `fail` / `not-drivable` |
| `capture`    | a `SUBJECTIVE: ` item                                    | reach the state from the item's own text, `take_screenshot` per size; **never judge** | `captured` / `not-captured`      |

**Per-item bounds.** At most **8 browser actions and one wait of 15s** per item. On overrun the verdict is `not-drivable` with the reason in `reason`, and the driver moves to the next item — one stubborn item never starves the rest.

**A behaviour `pass` means visible, not merely present.** The expected element must be in the a11y snapshot **and** inside the viewport (`getBoundingClientRect()` intersects the viewport, non-zero size). An element that exists off-screen or behind a closed disclosure is a `fail`.

**Capture sizes.** The sizes the item names (`at 375×667`, `at desktop width`); otherwise phone **390** and desktop **1280** wide — each set with one `emulate` call (`viewport: "<w>x<h>x1"`, plus `,mobile,touch` below 768 wide). Screenshots go under `.flow-tmp/ui-evidence/` through the same save-path cascade as the smoke pass, and only a path that survives `test -f` is reported.

**Reaching a state.** The item text is the only recipe (the rubric's "Precondition concreteness" requires it to spell out every precondition). Run any **local, reversible** setup it names. When the exact state cannot be reached, capture the nearest reachable state, verdict `captured`, `reason: "partial: <precondition not met>"` — a partial picture beats none and never ticks the box. When nothing useful can be captured, verdict `not-captured` with the reason; the caller writes it under the item as `no screenshot: <reason>`.

**Never capture a credential form.** The smoke pass's never-photograph-the-login-form rule applies unchanged to `behavior` and `capture` items: skip the screenshot, keep the snapshot text free of field values, and record `not-captured` with reason `credential form`. After the `flow-ui-login` fill runs, confirm login only via `evaluate_script () => location.pathname` — never snapshot or screenshot the page while still on `loginUrl`.

**A rate-limited route is not a failure.** A `behavior` or `appearance` item whose route shows a `rateLimited` URL requested fewer than 5 times is `not-drivable` with reason `data-precondition: <url> answered 429`, never `fail` — a quota is local app data, not a code defect, and a re-drive does not clear it. A URL requested 5 or more times is the app's own request storm and stays a failure.

**Degradation.** MCP absent, browser-profile busy, or launch/login failure takes the same loud `ran:false` skip as the smoke pass; the caller then leaves every `behavior` / `appearance` item open with the reason `browser-unavailable` and gives every `capture` item a `no screenshot:` line.

## Section capture (critique loop)

**Gate: the spawn prompt carries `SECTIONS: on` (verify passes it when the pre-drive `flow-ui-critique gate` returned `run:true`) or `MODE: sections`.** Neither marker means this section does not exist: zero cost, zero tool calls. With `SECTIONS: on`, capture only after ASSEMBLE returned `ok:true`, so a failing attempt's drive never pays for it. `MODE: sections` is the loop's one re-drive (caller stays `verify`, same exemption): the full normal drive above plus this capture, regardless of ASSEMBLE's outcome. Capture runs before teardown and never on `loginUrl`. **Write the result artifact first:** right after ASSEMBLE returns `ok:true` and before the first capture call, write the normal result artifact without `section_shots` / `route_snapshots`, then rewrite it with them once capture ends — a turn-budget overrun mid-capture then costs only the gallery, never the whole UI check. `MODE: sections` saves its images under `.flow-tmp/ui-evidence/critique-after/` instead of `critique/` (same filenames), so the re-drive never overwrites the round-0 images the review's Before column shows.

Per manifest route (touched routes first, at most 3), at phone (`emulate` with `viewport: "390x844x1,mobile,touch"`) and desktop (`viewport: "1280x800x1"`), plus `desktop-dark` (the desktop viewport with `colorScheme: "dark"`, and the probe's `darkSchemeClass` added to `document.documentElement` first) when the probe reported `hasDarkScheme` — a realistic height, not the main drive's tall default, so a viewport-sized screenshot is a real slice of the page:

1. `navigate_page` to the route and `wait_for` it.
2. `evaluate_script` the output of `flow-ui-validate --sections-script` (fetch it once per drive). It opens every collapsed `<details>` and returns `{innerHeight, sections}`.
3. For each returned section, `evaluate_script` a `scrollIntoView({block:"start", behavior:"instant"})` on its `selector`, then a viewport-sized `take_screenshot` (never full-page) to `.flow-tmp/ui-evidence/critique/<route-slug>-<n>-<viewport>.png` through the same save-path cascade as the main drive. A section taller than 1.5 × `innerHeight` also gets a `block:"end"` shot; the two files take `-start` / `-end` suffixes and `part` `start` / `end` (a single shot is `part: "whole"`).
4. `evaluate_script` the output of `flow-ui-validate --sections-restore-script` so every `<details>` it opened closes again.
5. At desktop, save the route's accessibility snapshot text (`take_snapshot`, at most 30,000 chars) to `.flow-tmp/ui-evidence/critique/<route-slug>.snapshot.txt` by passing `take_snapshot` the `filePath` argument through the same save-path cascade, so the text never passes back through the model. Fall back to the Write tool only when `filePath` is refused.

**Turn-budget cap.** The driver has a fixed turn budget (`maxTurns`), so issue independent read-only calls (`take_snapshot`, `list_console_messages`, `list_network_requests`) together in one turn per viewport, and capture at most 6 sections per route × viewport and at most 24 shots across the whole drive. Stop at the cap and name the number of sections skipped as `omittedSections` in the summary.

Record `section_shots[]` (`{route, section, viewport: "phone" | "desktop" | "desktop-dark", part, path}`) and `route_snapshots[]` (`{route, path}`) in the result artifact, under the schema caps (48 / 3 entries, every path under `.flow-tmp/ui-evidence/`). The driver captures and never judges: no finding, verdict or opinion about what it photographed.

## Design-fidelity sub-pass (spec-gated)

**Gate: this sub-pass exists only when the worktree-local `.flow-tmp/design/spec.json` exists.** No `spec.json` → the sub-pass does not exist — zero cost, zero prose, zero tool calls; the smoke pass above is byte-for-byte unchanged. (The spec is pipeline-ephemeral, frozen by discovery's design-artifact fidelity pre-pass and never committed.)

When the spec exists, after the existing per-route capture loop:

1. For each surface declared in the spec, on that surface's route run `flow-design-spec probe-script --spec .flow-tmp/design/spec.json --surface <name>` and evaluate the emitted JS via `evaluate_script` in the same isolated page.
2. The evaluated script returns a bare array of `{selector, found, properties}` — wrap it as `{"surface": "<name>", "captured": <returned array>}` before persisting. Persist that envelope to `.flow-tmp/design/capture-<surface>.json` **with the harness file-write tool (Write), NEVER via bash `echo`/heredoc string interpolation** — shell-interpolating arbitrary JSON is an escaping hazard (quotes, backticks, `$` in captured values).
3. Run `flow-design-spec diff --spec .flow-tmp/design/spec.json --captured .flow-tmp/design/capture-<surface>.json --json` per surface. Judged-tier assertions report `skipped-judged` here (they are review-time judgment, not gate-time mechanics).
4. Route any `ok:false` envelope through the **existing fix loop as a verify failure** — same loop as a failed `flow-pre-commit` check. **Fix-loop context re-injection:** a fidelity-failure entry carries the absolute paths of the committed `.flow/design/foundation.md` and the ephemeral `.flow-tmp/design/spec.json` alongside the failing assertion ids, so the fix pass re-reads the contract rather than patching blind.

Degradation is exactly the existing pass's: on MCP-absent or browser-busy, take the loud skip via the same `ui_smoke` reason carrier ("design-fidelity spec present; browser validation did not run — <reason>") — never a hard failure.

## Teardown (servers and browser, symmetric)

Tearing the launched server(s) down on completion is only half the cleanup —
the pass also opened a per-pipeline isolated page (`new_page` with an
`isolatedContext`), and that page/context must be torn down too, or the
chrome-devtools MCP Chrome is left running on the user's machine, holding its
profile lock and orphaning a browser window. Mirror the server teardown: on
completion **and on every error / early-exit path** (a launch failure, a
captures-assembly error, a fix-loop bail-out), close the per-pipeline isolated
page you opened — `close_page` on that page, disposing the `isolatedContext` —
in the same breath as bringing the launched server(s) down. Close **only** the
page/context THIS pipeline opened (keyed on the pipeline slug); never close a
sibling pipeline's page or any pre-existing page the user opened. `close_page`
takes the numeric `pageId` your `new_page` call returned — capture that id at
open time and pass exactly it; do NOT re-derive the page via `list_pages` at
teardown, since the `isolatedContext` name is not a closeable handle and a
`list_pages` scan under a shared MCP server can land on a sibling pipeline's
page or the user's own tab. The MCP-absent and headless paths opened nothing,
so teardown is a no-op there, never a failure. The `flow-spawn` process
registry is a BACKSTOP, not a replacement, for this teardown discipline: the
pass still tears the launched server(s) down at the point of use on
completion and on every error/early-exit path — no reaper runs here.

<!-- flow-denial-teardown -->

Exception — after a credential denial: make no further browser, MCP or teardown calls (the classifier treats them as tunneling the denied action). Write the artifact with `credentials-unavailable` and return. The pipeline's `flow-browser-teardown --reap --record` closes the page, the browser and the launched servers.

**One thing the wrapper DOES change about teardown.** `flow-spawn` launches
the server detached, in its own process group, so it is no longer in the Bash
tool's group — a group-directed kill aimed at the launching shell no longer
reaches it. Tear down by targeting what you launched: under `--detach` the
`flow-spawn` wrapper has already exited, so signal the printed pid's process
group (`kill -TERM -<pid>`), or kill the process group recorded as `pgid` in
the slug's registry row. A shell-job-style
teardown that relies on the server sharing the launcher's process group is
the form that silently stops working.

`close_page` is per-pass and stays as described above; it disposes the
`isolatedContext` but does NOT close the Chrome process — chrome-devtools-mcp
exposes no browser-close tool, and its own `closeBrowser()` runs only inside
the server's `shutdown()` handler. The browser process is reaped separately
by `flow-browser-teardown`, fired ONCE at the pipeline's terminal state and
NEVER per pass (a per-pass teardown would leave the later `/flow-pr-review`
visual-appearance pass without a browser — a regression, not a fix). That
server is launched by the Claude Code harness, cannot be wrapped by
`flow-spawn`, and stays on the ancestry-fallback path. After teardown has
fired, a further chrome-devtools MCP call in the same session is expected to
fail and MUST be treated exactly as `flow-ui-validate --mcp-absent`: a quiet
`ran:false` skip, never a failure.

**Agent-written env/config files.** Per the inline-only rule above, this pass
never writes a `.env.local`/`.env`/config file as part of normal operation —
but if any pass-created env/config file exists on disk at completion (e.g. a
recovery/debug artifact), delete it on completion **and on every error/
early-exit path**, scoped strictly to files this pass created — never a
pre-existing developer file.

## Fix-loop routing

A `ran:true` result with `ok:false` (a console error, a failed request, a missing `expectSelectors` element, a geometry defect, or a page-quality `heuristicIssues` defect such as leaked markup, an anchor landing under sticky chrome, content past the viewport, or contrast below 3:1) is a verify failure routed through the same fix loop as any failed `flow-pre-commit` check. When `geometryIssues` or `heuristicIssues` are non-empty, the fix pass re-reads its design contract rather than patching blind (the same re-injection as the design-fidelity sub-pass below): the plan's `## Layout Intent` (design-intent bullets included) and the `flow-ui-ux` `SKILL.md` plus `references/layout.md`, `references/visual-design.md` and `references/accessibility.md`, resolved with `flow-module-status --skill-path flow-ui-ux --ref <name>`, with the instruction "fix the source; preserve the content — never delete the offending text or wrap it in a scroller to dodge the check". Hand it to `/flow-coder` as the rule paths in each entry's `skill_docs` and the Layout Intent in the `DESIGN_CONTEXT` argument, the same two fields `/flow-new-feature` step 5 uses. Advisory `heuristicSmells` never fail the pass; `/flow-verify` relays them as `heuristic_smells`. Prefer a durable Playwright/vitest spec for any deterministic guard worth keeping forever; reserve the MCP pass for the live + visual-evidence checks.

## Smell-repair round

Runs from `/flow-verify` once the defect loop is green, when advisory smells remain on a touched route and `flow-ui-critique gate` did not return `run:true` (when it does, the critique loop in [ui-critique-loop.md](ui-critique-loop.md) replaces this round). Never runs under `UI_SMOKE_DRIVER: inline`: that caller cannot spawn the re-drive or `/flow-coder`.

1. Produce the comparison baseline deterministically, with no browser: `flow-ui-validate --manifest .flow/ui-validation.json --captures .flow-tmp/ui-captures.json > .flow-tmp/ui-findings.json`.
2. `flow-ui-critique round-begin --kind smell --worktree "$WORKTREE"` — it records the pre-round commit before any edit.
3. ONE fix round (one `/flow-coder` invocation) with the smell list, the design context named under "Fix-loop routing" above (rule paths as `skill_docs`, Layout Intent as `DESIGN_CONTEXT`), and the instruction "fix the source; preserve the content — never delete the offending text or wrap it in a scroller to dodge the check".
4. Re-drive once (one `flow-ui-driver` spawn), re-run the same `flow-ui-validate` ASSEMBLE command into `.flow-tmp/ui-findings-after.json`, then `flow-ui-validate --compare .flow-tmp/ui-findings.json .flow-tmp/ui-findings-after.json`.
5. `keep` means `flow-ui-critique round-end --worktree "$WORKTREE" --decision keep --reason "<before> smells -> <after>"`. `revert` means `git revert --no-edit <preSha>..HEAD` (history-preserving, safe after a push), then `flow-ui-critique round-end --worktree "$WORKTREE" --decision revert --reason "<why>"`.

Never a `NEEDS HUMAN`, never a second round; the smells that remain go to `/flow-verify`'s report.

## Noise filter

Benign request/console noise (canonically the favicon 404, which emits both a `/favicon.ico` failed request and a generic "Failed to load resource" console error) is suppressed via the manifest's optional `ignoreRequestPatterns` / `ignoreConsolePatterns` substring lists — manifest-config-only, no built-in default. **Adaptive noise filter:** when an `ok:false` flags a console error or failed request that is benign noise unrelated to the diff (a favicon 404, a third-party beacon/analytics request, browser-extension noise), do **not** consume a fix-loop attempt on it — add the offending substring to the manifest's `ignoreRequestPatterns` / `ignoreConsolePatterns` in `.flow/ui-validation.json` and **commit that manifest change** (it lands in the reviewable PR diff), then re-run; reserve the fix loop for post-filter errors the diff actually introduced. The same rule extends to the manifest's optional `ignoreHeuristicPatterns` (substring patterns matched against a heuristic message, e.g. `wall: main > section`): a pattern may only silence a smell or a soft defect the diff did not introduce, is committed with the manifest, and must be listed in `/flow-verify`'s report. A pattern that matches a `leak:` or `past-viewport:` message is refused (the helper returns it in `refusedIgnores`) — those are never suppressible. Every `ignoreHeuristicPatterns` entry the fix loop adds is also named in the PR body's `## Key decisions` as a `Suppressed:` bullet (pattern, route, why), and a fix outside the plan's task files is named the same way as a `Sibling fix:` bullet, so the owner sees both at the gate.

## Self-improving manifest

**Self-completing + self-maintaining manifest (CRITICAL):** reusing that same commit-the-manifest-change precedent, the agent completes and maintains EVERYTHING the smoketest needs, not just the launch. When it adapts on the fly to make a run work — tweaks the launch command, adds/changes an `env` var, fixes `baseUrl`, corrects a route that 404'd or a launch field that failed, records the `loginUrl` + credential env-var NAMES it verified during a bootstrap — it persists the launch adaptation back into `.flow/ui-validation.json` (env/launch/baseUrl/routes/loginUrl/credentialEnvVars), and does the same for every other field it verified, and commits it into the reviewable PR diff, so the next run starts deterministic. Runtime credential VALUES are resolved by `flow-ui-login` and NEVER persisted — the agent never reads them itself: the committed manifest stores names and non-secret config only — never a secret value.

## Where the MCP calls live

On the default (supervisor) path, the MCP tool calls live in the spawned
`flow-ui-driver` subagent's own isolated context — the Task-tool exemption
documented in `references/exemption-contracts.md`'s `/flow-verify`
Independent UI-Driver Subagent contract. Only under the
`UI_SMOKE_DRIVER: inline` marker (the `/flow-fix-applier-instructions`
re-run path, which has no Task tool) do the calls run inline in the
calling skill's own LLM context instead. Either way, `flow-ui-validate`
itself stays LLM-free and runs no nested LLM (no `claude -p`, no Task;
it is a pure subprocess and cannot drive MCP).
