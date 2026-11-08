# Daemon CPU per flow test run (2026-11)

How much macOS background daemon CPU one full flow test run causes, what drives it, and what this branch changed (flow#1010). Measured on 2026-11-08.

**Bottom line:** the two shipped levers remove work that is countable without noise: about 65 fewer first-run security scans and about 14,500 fewer file creations per full run. That is an estimated −0.7 s of `syspolicyd` and −1.6 s of `fseventsd` per run, about 6% of the ~39 s that `syspolicyd`, `fseventsd` and `kernel_task` take together (9.3 + 12.1 + 17.5 s medians on `main`). The CPU deltas could not confirm it, and they did not move the expected way: across 6 interleaved pairs the branch median was 1.7 s higher for `syspolicyd` (11.0 s vs 9.3 s) and 2.7 s higher for `kernel_task` (20.2 s vs 17.5 s), and 0.8 s lower for `fseventsd` (11.3 s vs 12.1 s), all inside the run-to-run spread; the one 3-suites-at-once pair came out lower (29.1 s vs 26.1 s `syspolicyd`). Host load from other pipelines swung between 4 and 199 during measurement, and run-to-run noise (8–22 s `syspolicyd` for the same tree) was larger than the effect.

## Method

- **Host:** Apple M5 Pro, macOS 27.2, 5–10 other flow pipelines live throughout.
- **Trees:** baseline is `main` at `d39fab6` in a separate clone sharing the branch's `node_modules`; the branch is this PR.
- **Probe:** `bun docs/eval/daemon-cpu.ts --repeat 1 --control -- <cmd>`. It samples cumulative CPU per daemon (`ps` by executable basename; `kernel_task` via `top -l 1 -pid 0`), runs the command, samples again, then sleeps the same wall time and samples an idle control. Net = run delta − control delta.
- **Pairing:** baseline and branch runs are interleaved so drift in background load hits both arms.
- **Deterministic counts:** process launches and hook runs come from one full run per tree with `GIT_TRACE2_EVENT` set. Counts are unaffected by host load.
- **Known gaps:**
  - Short-lived `mdworker_shared` importers start and exit inside a window, so before/after snapshots miss them.
  - `mds`/`mds_stores` net values go negative whenever other pipelines' builds index more during the control than during the run. They are mostly other pipelines' load, not this suite's, so this doc does not interpret them.
  - Measurement overhead (`log stream`) was used only for diagnosis, never during a CPU arm.

## Baseline

Full suite on `main`, net CPU-seconds per run (`syspolicyd` / `fseventsd` / `kernel_task`), wall time, and the 1-minute load average at start:

| Run | syspolicyd | fseventsd | kernel_task | Wall  | Load |
| --- | ---------- | --------- | ----------- | ----- | ---- |
| 1   | 8.0        | 12.1      | 15.2        | 63 s  | 29   |
| 2   | 8.1        | 10.2      | 17.5        | 51 s  | 16   |
| 3   | 9.1        | 9.7       | 17.4        | 58 s  | 13   |
| 4   | 15.7       | 22.5      | 25.8        | 104 s | 58   |
| 5   | 9.3        | 12.1      | 16.8        | 86 s  | 199  |
| 6   | 13.2       | 16.5      | 25.5        | 105 s | 85   |

Median: 9.3 s `syspolicyd`, 12.1 s `fseventsd`, 17.5 s `kernel_task`. All six runs passed 14,067 tests except run 6 (one live orphan-sweep test, a known load flake).

## Attribution

Per-exec and per-file costs, micro-benchmarked with the probe (`--repeat 3 --control`, medians):

| Workload                                               | syspolicyd |
| ------------------------------------------------------ | ---------- |
| 100 freshly written `#!/bin/sh` scripts, each run once | 1.09 s     |
| 100 runs of one already-run script                     | 0.03 s     |
| 2,000 `git --version`                                  | 0.33 s     |
| 2,000 `/usr/bin/true`                                  | 0.13 s     |
| 500 `node -e 0`                                        | 0.10 s     |

A freshly written script costs about 11 ms on its first run; any process launch costs about 0.07–0.2 ms.

What one full run does, from the trace2 census:

- **~11,600 git process launches**, an estimated ~2 s of `syspolicyd`. These are the tests' own git calls, and the largest countable share.
- **~1,040 `git init`/`clone` calls**, each copying git's 14 sample hooks plus a description file.
- **171 hook runs**, 145 of them through 79 distinct freshly written per-worktree copies of flow's chaining shim. That is 79 first-run scans, roughly 0.9 s.

Group runs on `main` (net `syspolicyd` / `fseventsd`, two runs each):

| Group                    | Files | syspolicyd | fseventsd |
| ------------------------ | ----- | ---------- | --------- |
| Installs flow hook shims | 15    | 3.8–5.1    | 3.3–5.0   |
| Writes PATH stub scripts | 2     | 0.2        | 0.1       |
| Only `git init`s         | 39    | 2.8–5.5    | 0.5–5.3   |

The PATH-stub group costs 0.2 s, under the plan's 1 s cut line, so the cached-stub helper (plan Tasks 5–6) was cut.

## Rejected options

- **Worker-threads pool:** one full run on `main` with `--pool threads` failed 22 tests (the per-process `$HOME` sandbox does not hold in threads) and showed no daemon gain (9.8 s `syspolicyd`). Not adopted; lazy `HOME` stays a below-bar candidate.
- **Isolation off (`--no-isolate`):** the full run hung past 16 minutes and was killed, so it produced no number. Not viable.
- **`*.noindex` or other non-watched temp locations:** 1,000 short-lived files cost the same `fseventsd` (0.08–0.13 s) in `$TMPDIR`, a `*.noindex` folder and `~/code/me`. Rejected.
- **Fewer launches of signed binaries:** launches cost 0.07–0.2 ms each. Cutting the tests' ~11,600 git calls is the largest remaining lever, but it means rewriting fixtures across dozens of files; left for a separate decision.
- **vitest 5 `fsModuleCache`:** caches transformed modules on disk, so it adds writes on a miss and does not touch the scan or file-watch paths.
- **Launch-free fast path for `reference-transaction` / `post-index-change` hooks:** built, measured and reverted. It saved ~200 of ~11,600 launches (~0.04 s) while adding two git calls to every hook install and a staleness trade-off.
- **Shared hard-linked shim seed across test files:** dropped before building. It would save at most ~15 scans while one existing test's write through a hook link could corrupt a seed file that concurrent pipelines share.
- **Terminal "Developer Tools" exemption from the first-run malware scan:** declined by the user for security reasons. Agents in these terminals run code from PRs, fetched pages and npm packages, which is what the scan protects against. Not measured, and `flow doctor` does not suggest it.

## After

What this branch changes, as counts from one traced full run per tree:

| Count per full run                           | main   | branch                                                        |
| -------------------------------------------- | ------ | ------------------------------------------------------------- |
| Distinct freshly written flow-hook files run | 79     | ≤15 (one shared shim per hook-installing test file's `$HOME`) |
| Files written per `git init`/`clone`         | 18     | 3                                                             |
| `git init`/`clone` calls                     | ~1,040 | ~1,050                                                        |
| Tests passed                                 | 14,067 | 14,098 (31 added)                                             |

Estimated effect from the per-unit costs above: −0.7 s `syspolicyd` (~65 fewer first-run scans) and −1.6 s `fseventsd` (~14,500 fewer file creations) per run.

Measured CPU, full suite. Branch runs 4–6 also carried the since-reverted hook fast path, which changes ~200 launches per run and is negligible here:

| Arm (median of 6 interleaved pairs) | syspolicyd | fseventsd | kernel_task |
| ----------------------------------- | ---------- | --------- | ----------- |
| main                                | 9.3        | 12.1      | 17.5        |
| branch                              | 11.0       | 11.3      | 20.2        |

| Arm (3 suites at once, one run each) | syspolicyd | fseventsd | kernel_task | Wall  |
| ------------------------------------ | ---------- | --------- | ----------- | ----- |
| main                                 | 29.1       | 38.0      | 57.9        | 113 s |
| branch                               | 26.1       | 33.4      | 50.8        | 104 s |

The paired medians are within noise. The same tree ranged from 8.0 to 21.8 s `syspolicyd` depending on host load, so a 0.7 s effect cannot show. The concurrent arm moved about 10% in the expected direction, but it is a single pair. Measured wall time also tracked host load rather than the branch: 45–131 s for one suite.

On the user's machine the remaining daemon load is mostly other pipelines' Spotlight indexing (#1011) and the tests' own process launches. This branch removes the countable per-run scan and file churn it targeted, at a size this host cannot resolve.
