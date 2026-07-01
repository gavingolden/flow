/**
 * One-way / export-only projection of an epic to GitHub native sub-issues.
 *
 * Pure mapper + a `GhRunner`-driven orchestrator. The mapper turns the
 * committed manifest + a `reconcile` board into the DESIRED GitHub shape (one
 * parent epic issue + one sub-issue per feature; merged features → closed).
 * The orchestrator diffs that desired shape against LIVE GitHub (exact-title
 * probe + `GET .../sub_issues`) and performs the create/link/close through an
 * injectable seam, so the whole module unit-tests with zero real GitHub access.
 *
 * Source of truth stays local: the manifest is read read-only, the open/close
 * signal is sourced from `reconcile(...).board` (status === "merged" ⇒ close),
 * and issue state is NEVER read back to influence the frontier. The
 * `~/.flow/epics/<slug>/projection.json` file is a HINT only — live GitHub is
 * the authority on every run, so a renamed feature / manually-deleted issue /
 * second machine re-probes rather than trusting the cache.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureLabels,
  parseCreateOutput,
  type GhRunner,
} from "../flow-create-issue";
import type { EpicManifest, Feature } from "./epic-manifest-schema";
import type { BoardRow } from "./epic-reconcile";
import { FLOW_EPICS_DIR } from "./paths";

type GhResult = ReturnType<GhRunner>;

/** The label applied to every projected issue so they are filterable/auditable. */
const PROJECTION_LABEL = "flow-epic";
const PROJECTION_STATE_FILENAME = "projection.json";

/** The pure desired-state shape (also the `--dry-run` JSON payload). */
export type ProjectionPlan = {
  parent: { title: string; body: string };
  children: Array<{ featureId: string; title: string; body: string }>;
  /** Every feature id — each child should be linked under the parent. */
  linksToCreate: string[];
  /** Feature ids whose board status is `merged` — their sub-issue closes. */
  subIssuesToClose: string[];
};

/** Per-feature hint persisted at `projection.json` (live GitHub is authority). */
type ProjectionHint = {
  parentNumber?: number;
  features: Record<string, { issueNumber: number; databaseId?: number }>;
};

export type ProjectionOutcome = {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  /** True when the confirmation gate was declined; zero mutating calls made. */
  aborted: boolean;
  plan?: ProjectionPlan;
  parentNumber?: number;
  /** Browsable URL of the parent epic issue (the human's entry point). */
  parentUrl?: string;
  /** feature id → its sub-issue's browsable URL (for created + reconciled). */
  issueUrls?: Record<string, string>;
  /** Feature ids (and "parent") whose issue was created this run. */
  created: string[];
  /** Feature ids linked under the parent this run. */
  linked: string[];
  /** Feature ids whose sub-issue was closed this run. */
  closed: string[];
  /** Feature ids already present + linked (no mutation needed). */
  skipped: string[];
};

function parentTitle(manifest: EpicManifest): string {
  // Title on the epicId slug, not the raw prompt: the prompt can be many
  // paragraphs (an unusable GitHub title) and can be edited, whereas the
  // epicId is short, stable, and the manifest's canonical identifier — which
  // also makes it a robust exact-title dedup key across re-runs/machines. The
  // full prompt lives in the body.
  return `Epic: ${manifest.epicId}`;
}

function childTitle(f: Feature): string {
  return `${f.id}: ${f.title}`;
}

function buildParentBody(manifest: EpicManifest): string {
  return [
    `Epic projected from the \`flow epic\` manifest \`${manifest.epicId}\`.`,
    "",
    "Export-only reflection of the epic's local manifest and pipeline state —",
    "edits here do not flow back into flow. Sub-issues close as features merge.",
    "",
    `## Features (${manifest.features.length})`,
    ...manifest.features.map((f) => `- \`${f.id}\` — ${f.title}`),
    "",
    "## Prompt",
    manifest.prompt,
  ].join("\n");
}

function buildChildBody(f: Feature): string {
  const deps =
    f.dependsOn.length > 0
      ? f.dependsOn.map((d) => `\`${d}\``).join(", ")
      : "none";
  return [
    f.description,
    "",
    `Feature \`${f.id}\` of the epic. Depends on: ${deps}.`,
  ].join("\n");
}

/** Pure: manifest + board → desired GitHub shape. No I/O. */
export function buildProjectionPlan(
  manifest: EpicManifest,
  board: BoardRow[],
): ProjectionPlan {
  const statusById = new Map(board.map((r) => [r.id, r.status]));
  return {
    parent: { title: parentTitle(manifest), body: buildParentBody(manifest) },
    children: manifest.features.map((f) => ({
      featureId: f.id,
      title: childTitle(f),
      body: buildChildBody(f),
    })),
    linksToCreate: manifest.features.map((f) => f.id),
    subIssuesToClose: manifest.features
      .filter((f) => statusById.get(f.id) === "merged")
      .map((f) => f.id),
  };
}

function isSecondaryRateLimit(r: GhResult): boolean {
  return (
    r.exitCode !== 0 && /secondary rate limit|\b403\b/i.test(r.stderr ?? "")
  );
}

function ghError(r: GhResult, ctx: string): string {
  if (isSecondaryRateLimit(r)) {
    return `GitHub secondary rate limit hit while trying to ${ctx} — wait a minute and re-run \`flow epic project\` (it resumes idempotently).`;
  }
  return (
    r.stderr.trim() || `gh failed (exit ${r.exitCode}) while trying to ${ctx}`
  );
}

function projectionStatePath(slug: string, epicsDir: string): string {
  return path.join(epicsDir, slug, PROJECTION_STATE_FILENAME);
}

function readHint(slug: string, epicsDir: string): ProjectionHint {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(projectionStatePath(slug, epicsDir), "utf8"),
    );
    if (parsed && typeof parsed === "object" && parsed.features) return parsed;
  } catch {
    /* missing/corrupt hint is fine — live GitHub is authority */
  }
  return { features: {} };
}

function writeHint(slug: string, epicsDir: string, hint: ProjectionHint): void {
  const file = projectionStatePath(slug, epicsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hint, null, 2) + "\n");
}

/** A live projected issue resolved from the bulk label-filtered list. */
type LiveIssue = { number: number; open: boolean; url: string };

/**
 * Resolve the parent + every child against GitHub in ONE call: list all issues
 * carrying `PROJECTION_LABEL` (across both states) and key them by exact title.
 *
 * `--state all` is load-bearing for correctness, not just speed: a CLOSED
 * merged sub-issue is invisible to an open-only title probe, so without it a
 * lost/absent `projection.json` would re-create an already-merged feature as a
 * duplicate open issue. Resolving in memory also collapses the old O(features)
 * serial title probes (one `gh issue list` per feature) into a single request.
 * Matching is by exact title, so issues from unrelated epics never collide; the
 * bound is `PROJECTION_LIST_LIMIT` total flow-epic issues across the repo.
 */
function listProjectedIssues(
  gh: GhRunner,
):
  | { ok: true; byTitle: Map<string, LiveIssue> }
  | { ok: false; error: string } {
  const r = gh([
    "issue",
    "list",
    "--label",
    PROJECTION_LABEL,
    "--state",
    "all",
    "--json",
    "number,title,state,url",
    "--limit",
    String(PROJECTION_LIST_LIMIT),
  ]);
  if (r.exitCode !== 0) {
    return { ok: false, error: ghError(r, "list projected epic issues") };
  }
  try {
    const arr = JSON.parse(r.stdout);
    const byTitle = new Map<string, LiveIssue>();
    if (Array.isArray(arr)) {
      for (const o of arr) {
        if (o && typeof o.number === "number" && typeof o.title === "string") {
          byTitle.set(o.title, {
            number: o.number,
            open: o.state === "OPEN",
            url: typeof o.url === "string" ? o.url : "",
          });
        }
      }
    }
    return { ok: true, byTitle };
  } catch (e) {
    return {
      ok: false,
      error: `issue list returned non-JSON: ${(e as Error).message}`,
    };
  }
}

function createIssue(
  title: string,
  body: string,
  gh: GhRunner,
): { ok: true; number: number; url: string } | { ok: false; error: string } {
  const r = gh([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--label",
    PROJECTION_LABEL,
  ]);
  if (r.exitCode !== 0)
    return { ok: false, error: ghError(r, `create issue '${title}'`) };
  const parsed = parseCreateOutput(r.stdout);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  return { ok: true, number: parsed.number, url: parsed.url };
}

/** The child's INTEGER database id — never the issue number or GraphQL node_id. */
function fetchDatabaseId(
  issueNumber: number,
  gh: GhRunner,
): { ok: true; id: number } | { ok: false; error: string } {
  const r = gh([
    "api",
    `repos/{owner}/{repo}/issues/${issueNumber}`,
    "--jq",
    ".id",
  ]);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      error: ghError(r, `fetch database id for #${issueNumber}`),
    };
  }
  const id = Number(r.stdout.trim());
  if (!Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      error: `unexpected database id for #${issueNumber}: ${r.stdout.trim()}`,
    };
  }
  return { ok: true, id };
}

function listExistingLinks(
  parentNumber: number,
  gh: GhRunner,
): { ok: true; numbers: Set<number> } | { ok: false; error: string } {
  // `--paginate` so ALL linked sub-issues are read, not just the first page:
  // the REST sub_issues endpoint defaults to per_page=30 while a parent allows
  // up to MAX_SUB_ISSUES (100). Without it, a >30-feature epic's re-run sees
  // only links 1–30, re-POSTs links 31+ that already exist, and the duplicate
  // link 422s into a hard fail — defeating the idempotency guarantee.
  const r = gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/issues/${parentNumber}/sub_issues`,
  ]);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      error: ghError(r, `list sub-issues of #${parentNumber}`),
    };
  }
  try {
    const arr = JSON.parse(r.stdout);
    const numbers = new Set<number>();
    if (Array.isArray(arr)) {
      for (const o of arr) {
        if (o && typeof o.number === "number") numbers.add(o.number);
      }
    }
    return { ok: true, numbers };
  } catch (e) {
    return {
      ok: false,
      error: `sub_issues GET returned non-JSON: ${(e as Error).message}`,
    };
  }
}

function linkSubIssue(
  parentNumber: number,
  childDatabaseId: number,
  gh: GhRunner,
): { ok: true } | { ok: false; error: string } {
  // `-F` (not `-f`) so gh sends `sub_issue_id` as a JSON integer — the REST
  // "add sub-issue" endpoint rejects the issue number / node_id and a stringy
  // `-f` value; the integer database id is load-bearing here.
  const r = gh([
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/issues/${parentNumber}/sub_issues`,
    "-F",
    `sub_issue_id=${childDatabaseId}`,
  ]);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      error: ghError(
        r,
        `link sub-issue ${childDatabaseId} to #${parentNumber}`,
      ),
    };
  }
  return { ok: true };
}

function closeIssue(
  issueNumber: number,
  gh: GhRunner,
): { ok: true } | { ok: false; error: string } {
  const r = gh(["issue", "close", String(issueNumber)]);
  if (r.exitCode !== 0)
    return { ok: false, error: ghError(r, `close #${issueNumber}`) };
  return { ok: true };
}

export type ProjectEpicArgs = {
  slug: string;
  manifest: EpicManifest;
  board: BoardRow[];
  gh: GhRunner;
  epicsDir?: string;
  dryRun?: boolean;
  yes?: boolean;
  confirm?: (message: string) => boolean;
};

const MAX_SUB_ISSUES = 100;

// Upper bound on the single label-filtered probe list. One fully-projected epic
// is ≤101 issues (1 parent + ≤100 children), so this leaves headroom for ~10
// projected epics coexisting in one repo before the list could truncate.
const PROJECTION_LIST_LIMIT = 1000;

function fail(error: string, dryRun = false): ProjectionOutcome {
  return {
    ok: false,
    error,
    dryRun,
    aborted: false,
    created: [],
    linked: [],
    closed: [],
    skipped: [],
  };
}

/**
 * Diff the desired projection against live GitHub and create/link/close. The
 * >100-feature guard fires before any gh call; `--dry-run` prints the planned
 * actions and makes zero gh calls; the confirmation gate (unless `--yes`) names
 * how many issues will be created and aborts with zero mutating calls if
 * declined.
 */
export function projectEpic(args: ProjectEpicArgs): ProjectionOutcome {
  const { slug, manifest, board, gh } = args;
  const epicsDir = args.epicsDir ?? FLOW_EPICS_DIR;
  const dryRun = args.dryRun ?? false;
  const yes = args.yes ?? false;

  // >100-feature guard FIRST — before any gh call (GitHub caps a parent at 100
  // sub-issues; projecting more would create issues that can never link).
  if (manifest.features.length > MAX_SUB_ISSUES) {
    return fail(
      `epic '${slug}' has ${manifest.features.length} features but GitHub caps sub-issues at ${MAX_SUB_ISSUES} per parent — split the epic before projecting.`,
      dryRun,
    );
  }

  const plan = buildProjectionPlan(manifest, board);

  if (dryRun) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return {
      ok: true,
      dryRun: true,
      aborted: false,
      plan,
      created: [],
      linked: [],
      closed: [],
      skipped: [],
    };
  }

  const hint = readHint(slug, epicsDir);
  const mergedIds = new Set(plan.subIssuesToClose);

  // --- Probe phase (read-only): ONE label-filtered, all-state list resolves the
  // parent and every child by exact title in memory.
  const live = listProjectedIssues(gh);
  if (!live.ok) return fail(live.error);

  const parentLive = live.byTitle.get(plan.parent.title);

  type ChildPlan = {
    featureId: string;
    title: string;
    body: string;
    existing: { number: number; open: boolean; url: string } | null;
  };
  const children: ChildPlan[] = plan.children.map((c) => {
    const found = live.byTitle.get(c.title);
    return {
      ...c,
      existing: found
        ? { number: found.number, open: found.open, url: found.url }
        : null,
    };
  });

  const willCreateParent = parentLive === undefined;
  const childCreateCount = children.filter((c) => c.existing === null).length;
  const toCreateCount = (willCreateParent ? 1 : 0) + childCreateCount;

  // --- Confirmation gate (irreversible real-issue write). Only when there are
  // issues to create; --yes skips it. Reversible link/close reconciliation
  // still proceeds even when nothing is created. The breakdown names only what
  // will ACTUALLY be created — it omits the parent when it already exists.
  if (toCreateCount > 0 && !yes) {
    const confirm = args.confirm;
    const childPart = `${childCreateCount} sub-issue${childCreateCount === 1 ? "" : "s"}`;
    const breakdown = willCreateParent
      ? childCreateCount > 0
        ? `1 parent epic + ${childPart}`
        : "1 parent epic"
      : childPart;
    const message = `flow epic project: this will create ${toCreateCount} real GitHub issue${toCreateCount === 1 ? "" : "s"} in the current repo (${breakdown}). Proceed?`;
    if (!confirm || !confirm(message)) {
      return {
        ok: true,
        dryRun: false,
        aborted: true,
        plan,
        created: [],
        linked: [],
        closed: [],
        skipped: [],
      };
    }
  }

  const created: string[] = [];
  const linked: string[] = [];
  const closed: string[] = [];
  const skipped: string[] = [];
  const nextHint: ProjectionHint = { features: {} };

  if (toCreateCount > 0) {
    const labelResult = ensureLabels([PROJECTION_LABEL], gh);
    if (labelResult.kind === "error") return fail(labelResult.message);
  }

  // --- Parent.
  let parentNumber: number;
  let parentUrl: string;
  let parentPreexisted: boolean;
  const issueUrls: Record<string, string> = {};
  if (parentLive !== undefined) {
    parentNumber = parentLive.number;
    parentUrl = parentLive.url;
    parentPreexisted = true;
  } else {
    const c = createIssue(plan.parent.title, plan.parent.body, gh);
    if (!c.ok) return fail(c.error);
    parentNumber = c.number;
    parentUrl = c.url;
    parentPreexisted = false;
    created.push("parent");
  }
  nextHint.parentNumber = parentNumber;

  // Existing links only exist when the parent pre-existed; a fresh parent has none.
  let existingLinks = new Set<number>();
  if (parentPreexisted) {
    const links = listExistingLinks(parentNumber, gh);
    if (!links.ok) return fail(links.error);
    existingLinks = links.numbers;
  }

  // --- Children: create-if-missing, link-if-unlinked, close-if-merged-and-open.
  for (const c of children) {
    let childNumber: number;
    let childOpen: boolean;
    let databaseId: number | undefined;
    if (c.existing) {
      childNumber = c.existing.number;
      // `--state all` gave us the live open/closed state directly, so a merged
      // feature whose sub-issue is already closed skips the redundant close.
      childOpen = c.existing.open;
      databaseId = hint.features[c.featureId]?.databaseId;
      if (c.existing.url) issueUrls[c.featureId] = c.existing.url;
    } else {
      const cr = createIssue(c.title, c.body, gh);
      if (!cr.ok) return fail(cr.error);
      childNumber = cr.number;
      childOpen = true;
      issueUrls[c.featureId] = cr.url;
      created.push(c.featureId);
    }

    if (!existingLinks.has(childNumber)) {
      if (databaseId === undefined) {
        const db = fetchDatabaseId(childNumber, gh);
        if (!db.ok) return fail(db.error);
        databaseId = db.id;
      }
      const link = linkSubIssue(parentNumber, databaseId, gh);
      if (!link.ok) return fail(link.error);
      linked.push(c.featureId);
    } else {
      skipped.push(c.featureId);
    }

    if (mergedIds.has(c.featureId) && childOpen) {
      const close = closeIssue(childNumber, gh);
      if (!close.ok) return fail(close.error);
      closed.push(c.featureId);
    }

    nextHint.features[c.featureId] = {
      issueNumber: childNumber,
      ...(databaseId !== undefined ? { databaseId } : {}),
    };
  }

  writeHint(slug, epicsDir, nextHint);

  return {
    ok: true,
    dryRun: false,
    aborted: false,
    plan,
    parentNumber,
    parentUrl,
    issueUrls,
    created,
    linked,
    closed,
    skipped,
  };
}
