#!/usr/bin/env bun
/**
 * `flow-epic-sync [--slug <feature-slug>] [--epic-slug <epic>] [--check] [--json]`
 *
 * Derives the WHOLE epic's committed status board from GitHub and
 * writes/checks `.flow/epics/<slug>/status.json`. LLM-free, tolerant — any
 * gh failure degrades to `derived: false` and NEVER blocks the caller (a
 * `pr-review` fix commit, a `flow epic done` close-out heal, or a manual
 * `--check` drift probe).
 *
 * Epic resolution order: explicit `--epic-slug`; else `--slug`/`$FLOW_SLUG`
 * -> `~/.flow/state/<slug>.json` `.epic.slug`. No epic resolved => exit 0,
 * write nothing, print nothing (mirrors `bin/flow-epic-membership.ts`). The
 * slug resolves env-first from `FLOW_SLUG` — never a tmux pane option (AGENTS.md:
 * "don't make tmux pane state load-bearing").
 *
 * ONE-WAY LATCH: every row (including the optimistic self-mark) runs through
 * `advanceStatus` from `./lib/epic-status-schema` — a shipped row never
 * regresses, so concurrent sibling epic PRs converge in any merge order.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readState } from "./lib/state";
import { FLOW_STATE_DIR, FLOW_EPICS_DIR } from "./lib/paths";
import { readEpicRunState } from "./lib/epic-run-state";
import {
  epicDirRelative,
  EPIC_MANIFEST_FILENAME,
  validateEpicManifest,
  type EpicManifest,
} from "./lib/epic-manifest-schema";
import {
  advanceStatus,
  EPIC_STATUS_FILENAME,
  readCommittedStatus,
  serializeEpicStatus,
  type CommittedFeatureRow,
  type EpicStatusFile,
} from "./lib/epic-status-schema";
import { slugify } from "./lib/slug";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { defaultGh, type GhRunner } from "./lib/resume-probes";

// --- Manifest loading (read-only, tolerant) ---------------------------------

function loadManifest(manifestPath: string): EpicManifest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const shape = validateEpicManifest(parsed);
  return shape.ok ? shape.value : null;
}

function resolveRepoRoot(cwd: string): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (r.exitCode !== 0) return null;
  const out = r.stdout.toString("utf8").trim();
  return out.length > 0 ? out : null;
}

// --- deriveBoard: pure, no disk/network -------------------------------------

/**
 * Query a feature's PR head branch. `merged` rows filter `--state merged` at
 * the gh level; the optimistic self-row query carries no state filter so it
 * can recover the PR number even while the PR is still open.
 */
function fetchPrNumber(
  gh: GhRunner,
  head: string,
  filterMerged: boolean,
): { ok: true; number?: number } | { ok: false } {
  const args = filterMerged
    ? [
        "pr",
        "list",
        "--head",
        head,
        "--state",
        "merged",
        "--json",
        "number",
        "--limit",
        "10",
      ]
    : ["pr", "list", "--head", head, "--json", "number", "--limit", "10"];
  const result = gh(args);
  if (result.exitCode !== 0) return { ok: false };
  try {
    const rows = JSON.parse(result.stdout) as Array<{ number?: number }>;
    const first = rows.find((r) => typeof r.number === "number");
    return { ok: true, number: first?.number };
  } catch {
    return { ok: false };
  }
}

/**
 * PURE whole-epic reconcile: for every manifest feature, derive its
 * committed row from GitHub (a merged PR head-matching `slugify(id)`), run
 * it through the one-way latch against the existing committed row, and
 * return the resulting file. `derived: false` when ANY gh call in the sweep
 * fails (non-zero exitCode / unparseable stdout) — callers must then write
 * nothing, so a single flaky gh call never manufactures a partial board.
 */
export function deriveBoard(input: {
  manifest: EpicManifest;
  existing: EpicStatusFile | null;
  gh: GhRunner;
  selfFeatureId?: string;
}): { file: EpicStatusFile; derived: boolean } {
  const { manifest, existing, gh, selfFeatureId } = input;
  const existingFeatures = existing?.features ?? {};
  const features: Record<string, CommittedFeatureRow> = {};
  let sawFailure = false;

  for (const f of manifest.features) {
    const isSelf = f.id === selfFeatureId;
    const existingRow = existingFeatures[f.id];
    // ONE-WAY LATCH SKIP: a row already committed `merged` with a `pr`
    // number can never regress through `advanceStatus`, so re-querying gh
    // for it can only reproduce the same row (or get discarded by the
    // latch if it somehow didn't). Skip the query — but self and
    // `not-started` rows are still queried unconditionally: self needs a
    // fresh PR number every run (the claim isn't committed until this PR
    // lands), and `not-started` is the whole point of the out-of-band
    // backstop this sweep exists to provide.
    if (!isSelf && existingRow?.status === "merged" && existingRow.pr) {
      features[f.id] = existingRow;
      continue;
    }
    const fetched = fetchPrNumber(gh, slugify(f.id), !isSelf);
    let derivedRow: CommittedFeatureRow = { status: "not-started" };
    if (!fetched.ok) {
      sawFailure = true;
    } else if (isSelf) {
      // OPTIMISTIC SELF-MARK: the claim exists only on the PR branch, so it
      // becomes true the instant this PR lands and never reaches the base
      // branch if the PR is closed. Scoped to exactly this row.
      derivedRow = { status: "merged", pr: fetched.number };
    } else if (fetched.number !== undefined) {
      derivedRow = { status: "merged", pr: fetched.number };
    }
    features[f.id] = advanceStatus(existingRow, derivedRow);
  }

  const file: EpicStatusFile = {
    version: 1,
    epicId: manifest.epicId,
    features,
  };
  return { file, derived: !sawFailure };
}

// --- CLI ---------------------------------------------------------------------

type ParsedArgs = {
  slug?: string;
  epicSlug?: string;
  epicFeature?: string;
  check: boolean;
  json: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { check: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--slug") {
      out.slug = argv[++i];
    } else if (a === "--epic-slug") {
      out.epicSlug = argv[++i];
    } else if (a === "--epic-feature") {
      out.epicFeature = argv[++i];
    } else if (a === "--check") {
      out.check = true;
    } else if (a === "--json") {
      out.json = true;
    }
  }
  return out;
}

const USAGE =
  "usage: flow-epic-sync [--slug <feature-slug>] [--epic-slug <epic>] [--epic-feature <id>] [--check] [--json]\n" +
  "  --epic-feature <id>  override the self-mark feature id when it can't be\n" +
  "                       derived from state (paired with --epic-slug; the\n" +
  "                       ambient --slug path derives it from state.epic.featureId)";

type Deps = {
  gh?: GhRunner;
  cwd?: string;
  stateDir?: string;
  epicsDir?: string;
  env?: NodeJS.ProcessEnv;
};

type SyncEnvelope = {
  epicSlug: string;
  derived: boolean;
  written: boolean;
  features: Record<string, CommittedFeatureRow>;
};

function syncEnvelope(
  epicSlug: string,
  derived: boolean,
  written: boolean,
  features: Record<string, CommittedFeatureRow>,
): SyncEnvelope {
  return { epicSlug, derived, written, features };
}

function emptyEnvelope(epicSlug: string): SyncEnvelope {
  return syncEnvelope(epicSlug, false, false, {});
}

export function main(argv: string[], deps: Deps = {}): number {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  const gh = deps.gh ?? defaultGh;
  const cwd = deps.cwd ?? process.cwd();
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const epicsDir = deps.epicsDir ?? FLOW_EPICS_DIR;
  const env = deps.env ?? process.env;

  let epicSlug = parsed.epicSlug;
  let selfFeatureId = parsed.epicFeature;
  if (!epicSlug) {
    const featureSlug = parsed.slug ?? resolveSlugFromEnv(env) ?? undefined;
    if (!featureSlug) return 0; // no epic resolvable: silent no-op
    const state = readState(featureSlug, stateDir);
    const epic = state?.epic;
    if (!epic?.slug) return 0; // non-epic feature: silent no-op
    epicSlug = epic.slug;
    if (!selfFeatureId) selfFeatureId = epic.featureId;
  }

  const runState = readEpicRunState(epicSlug, epicsDir);
  let manifestPath = runState?.manifestPath ?? null;
  if (!manifestPath) {
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot) {
      manifestPath = path.join(
        repoRoot,
        epicDirRelative(epicSlug),
        EPIC_MANIFEST_FILENAME,
      );
    }
  }

  const manifest = manifestPath ? loadManifest(manifestPath) : null;
  if (!manifest || !manifestPath) {
    // Manifest unreadable — never block the caller. `--check` DOES exit 1
    // here (unlike the gh-failure branch below): an unreadable manifest is
    // a repo-state problem the caller can fix (bad path, corrupt JSON),
    // while a gh failure is an environment blip the caller can't act on
    // mid-PR — so only the former is worth failing a drift check over.
    if (parsed.json) console.log(JSON.stringify(emptyEnvelope(epicSlug)));
    return parsed.check ? 1 : 0;
  }

  const epicDirAbs = path.dirname(manifestPath);
  const existing = readCommittedStatus(epicDirAbs);
  if (existing && existing.epicId !== manifest.epicId) {
    // A committed status.json whose epicId disagrees with the manifest is
    // either stale (epic renamed) or, worst case, a PR-authored file
    // claiming authority over a different epic than the one this run is
    // reconciling. Refuse to trust it as a base for the latch rather than
    // silently merging two epics' rows.
    if (parsed.json) console.log(JSON.stringify(emptyEnvelope(epicSlug)));
    return parsed.check ? 1 : 0;
  }
  const { file, derived } = deriveBoard({
    manifest,
    existing,
    gh,
    selfFeatureId,
  });

  if (!derived) {
    if (parsed.json) console.log(JSON.stringify(emptyEnvelope(epicSlug)));
    return 0; // gh unavailable — never block a PR.
  }

  const serialized = serializeEpicStatus(file);

  if (parsed.check) {
    const onDisk = existing ? serializeEpicStatus(existing) : null;
    const inSync = onDisk === serialized;
    if (parsed.json) {
      console.log(
        JSON.stringify(syncEnvelope(epicSlug, true, false, file.features)),
      );
    }
    return inSync ? 0 : 1;
  }

  const onDisk = existing ? serializeEpicStatus(existing) : null;
  const written = onDisk !== serialized;
  if (written) {
    fs.mkdirSync(epicDirAbs, { recursive: true });
    fs.writeFileSync(path.join(epicDirAbs, EPIC_STATUS_FILENAME), serialized);
  }

  if (parsed.json) {
    console.log(
      JSON.stringify(syncEnvelope(epicSlug, true, written, file.features)),
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
