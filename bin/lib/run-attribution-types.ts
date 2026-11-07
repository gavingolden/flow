import type { ModelEffortRun } from "./transcript-turns";

export const RUN_ATTRIBUTION_VERSION = 1;

export type UnitAttribution = {
  session_id: string;
  model: string | null;
  runs: ModelEffortRun[];
  /** Dollar cost of each run in `runs` (null when the run's model is unpriced); lets totals be recomputed from units alone. */
  run_costs: (number | null)[];
  turns: number;
  tokens: {
    input: number;
    cache_creation: number;
    cache_read: number;
    output: number;
    total: number;
  };
  cost_usd: number | null;
};

export type SpawnAttribution = UnitAttribution & {
  role: string;
  agent_type: string | null;
  /** The supervisor session whose `subagents/` dir held this spawn. */
  parent_session_id: string;
};

export type DelegatedCall = {
  event: string;
  task: string | null;
  model: string | null;
  effort: string | null;
  ran: boolean | null;
  skip_reason: string | null;
  ts: string;
  cost_usd: number | null;
};

export type ModelEffortTotal = {
  model: string;
  effort: string;
  turns: number;
  cost_usd: number | null;
};

export type RunTotals = {
  cost_usd: number;
  unpriced_models: string[];
  skipped_files: number;
  unattributed_effort_turns: number;
  by_model_effort: ModelEffortTotal[];
};

export type RunAttribution = {
  version: 1;
  slug: string;
  pr: number | null;
  repo: string;
  sessions: UnitAttribution[];
  spawns: SpawnAttribution[];
  delegated: DelegatedCall[];
  totals: RunTotals;
};
