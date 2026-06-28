#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook for the /flow-pipeline (and /epic-create)
 * supervisor.
 *
 * When a prompt is submitted inside a flow session — slug resolved from the
 * tmux pane's `@flow-slug` user option, exactly like flow-stop-guard — this
 * stamps `seedIngestedAt` onto `~/.flow/state/<slug>.json` the instant the
 * seed prompt is accepted. That marker is the launch-time confirmation the
 * launcher's `consumed()` predicate wants: success can latch the moment the
 * seed is ingested rather than waiting for the supervisor's first phase write.
 *
 * Self-detection: exits 0 cleanly when not in tmux, when the current window
 * has no `@flow-slug` option (a normal coding session), or when state.json is
 * missing — making it safe to register in a flow-scoped settings file passed
 * to `claude --settings`. It writes ONLY the per-pipeline state file under
 * `~/.flow/state/`, never the user's global Claude Code settings; the marker is
 * idempotent (re-stamping a state that already carries it is a no-op, so it
 * never churns the file or the supervisor's own `updatedAt`).
 */

import { spawnSync } from "node:child_process";
import {
  nowIso as defaultNowIso,
  readState,
  writeState,
  type PipelineState,
} from "./lib/state";

export type Deps = {
  tmuxPane: string | undefined;
  showFlowSlug: (pane: string) => string;
  loadState: (slug: string) => PipelineState | null;
  saveState: (state: PipelineState) => void;
  nowIso: () => string;
};

export function run(deps: Deps): number {
  const pane = deps.tmuxPane;
  if (!pane) return 0;

  const slug = deps.showFlowSlug(pane).trim();
  if (slug.length === 0) return 0;

  const state = deps.loadState(slug);
  if (!state) return 0;

  // Idempotent: the first submit stamps the marker; subsequent prompts in the
  // same session are a no-op (the launch-time ingestion signal is already set).
  if (state.seedIngestedAt) return 0;

  deps.saveState({ ...state, seedIngestedAt: deps.nowIso() });
  return 0;
}

export function defaultShowFlowSlug(pane: string): string {
  const r = spawnSync(
    "tmux",
    ["show-options", "-w", "-t", pane, "-q", "-v", "@flow-slug"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

if (import.meta.main) {
  process.exit(
    run({
      tmuxPane: process.env.TMUX_PANE,
      showFlowSlug: defaultShowFlowSlug,
      loadState: (slug) => readState(slug),
      saveState: (state) => writeState(state),
      nowIso: defaultNowIso,
    }),
  );
}
