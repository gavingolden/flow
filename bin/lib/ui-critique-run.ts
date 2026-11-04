/**
 * The one model call of the UI critique loop: a capped, read-only critic over
 * the screenshot gallery. Extracted from `bin/flow-ui-critique.ts`, which keeps
 * only argument parsing and wiring.
 */
import * as path from "node:path";

import { selectGallery } from "./ui-critique-gallery";
import { validateFindings } from "./ui-critique";
import {
  buildCritiquePrompt,
  extractLayoutIntent,
  parseJsonReply,
} from "./ui-critique-prompt";
import {
  critDir,
  readJson,
  readLog,
  writeLog,
  type Flags,
  type OpResult,
  type OpsDeps,
} from "./ui-critique-ops";
import type { SectionShot, UiDriverItemResult } from "./ui-driver-schema";
import { itemCapturesToShots } from "./ui-signoff-shots";

export const CRITIC_MODEL = "opus";
export const CRITIC_EFFORT = "high";
export const CRITIC_MAX_BUDGET_USD = 3;
export const CRITIC_TIMEOUT_SEC = 600;
const CRITIC_MAX_TURNS = 40;

const RULE_REFS = [
  "references/rendered-critique.md",
  "references/visual-design.md",
  "references/layout.md",
  "references/accessibility.md",
] as const;

/** The `flow-claude-headless` stdout envelope, as far as we read it. */
export type HeadlessEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifact?: string;
  total_cost_usd?: number;
};

export type Deps = OpsDeps & {
  spawnHeadless: (argv: string[], opts: { cwd: string }) => HeadlessEnvelope;
  mkdtemp: () => string;
  removeDir: (dir: string) => void;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
};

export function critique(f: Flags, deps: Deps): OpResult {
  const w = typeof f.worktree === "string" ? f.worktree : process.cwd();
  const phase = f.phase;
  if (phase !== "round-0" && phase !== "post-round" && phase !== "review-8c") {
    return { ran: false, skipReason: "bad-phase" };
  }
  // review-8c judges the sign-off screenshots as advice, after the loop has
  // completed; it never touches residual, persistent or the DECISION item.
  const signoff = phase === "review-8c";
  // The $3 per-call cap is enforced by the headless child; the call count
  // lives here because this subcommand is pre-approved without classifier
  // review, so a looping caller must not be able to re-spend.
  const prior = readLog(deps, w);
  if (prior.completed && !signoff) {
    return { ran: false, skipReason: "already-ran" };
  }
  if (prior.critiqueCalls.includes(phase)) {
    return { ran: false, skipReason: "phase-already-critiqued" };
  }
  const driver = readJson(deps, String(f["driver-result"])) as {
    section_shots?: SectionShot[];
    route_snapshots?: { route: string; path: string }[];
    item_results?: UiDriverItemResult[];
    fix_context?: { item?: string; route: string }[];
  } | null;
  const gallery = selectGallery(
    signoff
      ? itemCapturesToShots(driver?.item_results ?? [], driver?.fix_context)
      : (driver?.section_shots ?? []),
  );
  if (gallery.shots.length === 0) {
    return {
      ran: false,
      skipReason: signoff ? "no-signoff-captures" : "no-section-shots",
    };
  }

  // The headless critic may only be able to Read inside its working
  // directory, so the rule docs are copied under the worktree and the
  // copies' paths are what the prompt lists.
  const rulesDir = path.join(critDir(w), "rules");
  deps.mkdirp(rulesDir);
  const ruleDocPaths: string[] = [];
  for (const ref of RULE_REFS) {
    const src = deps.resolveSkillPath("flow-ui-ux", ref);
    if (src === null || !deps.fileExists(src)) {
      return { ran: false, skipReason: "rule-doc-missing" };
    }
    const dest = path.join(rulesDir, path.basename(ref));
    deps.copyFile(src, dest);
    ruleDocPaths.push(dest);
  }

  const targets = readJson(deps, path.join(critDir(w), "targets.json"));
  const changedFiles = (
    deps.readFile(path.join(critDir(w), "changed-files.txt")) ?? ""
  )
    .split("\n")
    .filter((l) => l.length > 0);
  const findings =
    typeof f.smells === "string" ? readJson(deps, f.smells) : null;
  const routes = (
    findings as { routes?: { heuristicSmells?: string[] }[] } | null
  )?.routes;
  const prompt = buildCritiquePrompt({
    shots: gallery.shots,
    snapshots: driver?.route_snapshots ?? [],
    layoutIntent: extractLayoutIntent(deps.readFile(String(f.plan)) ?? ""),
    ruleDocPaths,
    smells: (routes ?? []).flatMap((r) => r.heuristicSmells ?? []).slice(0, 40),
    phase,
    targets:
      Array.isArray(targets) && !signoff
        ? (targets as { route: string; state: string | null }[])
        : [],
    changedFiles,
  });

  writeLog(deps, w, {
    ...prior,
    critiqueCalls: [...prior.critiqueCalls, phase],
    // The first critique judges the HEAD verify reached; a kept round
    // re-stamps it. Stamping at the pre-drive gate would mark verify's own
    // later fix commits as "UI changed after the review".
    ...(phase === "round-0"
      ? { headSha: deps.gitHead(w) ?? prior.headSha }
      : {}),
    ...(signoff
      ? {}
      : {
          omittedSections: Math.max(
            prior.omittedSections,
            gallery.omittedSections,
          ),
        }),
  });
  const recordSpend = (usd: unknown): void => {
    if (typeof usd !== "number" || !(usd > 0)) return;
    const cur = readLog(deps, w);
    writeLog(deps, w, { ...cur, costUsd: cur.costUsd + usd });
  };
  const scratch = deps.mkdtemp();
  const promptPath = path.join(scratch, "ui-critique-prompt.md");
  const childOut = path.join(
    w,
    ".flow-tmp",
    `headless-ui-critique-${phase}.json`,
  );
  let envelope: HeadlessEnvelope;
  try {
    deps.writeFile(promptPath, prompt);
    deps.mkdirp(path.join(w, ".flow-tmp"));
    envelope = deps.spawnHeadless(
      [
        "--prompt-file",
        promptPath,
        "--model",
        CRITIC_MODEL,
        "--effort",
        CRITIC_EFFORT,
        "--allowed-tools",
        "Read",
        "--max-budget-usd",
        String(CRITIC_MAX_BUDGET_USD),
        "--max-turns",
        String(CRITIC_MAX_TURNS),
        "--timeout-sec",
        String(CRITIC_TIMEOUT_SEC),
        "--task",
        `ui-critique-${phase}`,
        "--out",
        childOut,
      ],
      { cwd: w },
    );
  } finally {
    deps.removeDir(scratch);
  }
  recordSpend(envelope.total_cost_usd);
  if (envelope.ran !== true) {
    return { ran: false, skipReason: envelope.skipReason ?? "headless-error" };
  }

  const artifact = envelope.artifact ? readJson(deps, envelope.artifact) : null;
  const text = (artifact as { result?: unknown } | null)?.result;
  const validated = validateFindings(
    typeof text === "string" ? parseJsonReply(text) : null,
    gallery.shots.map((s) => s.path),
  );
  if (!validated.ok) {
    return {
      ran: false,
      skipReason: "unparseable-result",
      total_cost_usd: envelope.total_cost_usd,
    };
  }
  if (signoff) {
    const cur = readLog(deps, w);
    writeLog(deps, w, {
      ...cur,
      signoff: {
        findings: validated.findings,
        judgedSha: deps.gitHead(w) ?? "",
      },
    });
  }
  const out = String(f.out);
  deps.mkdirp(path.dirname(out));
  deps.writeFile(
    out,
    JSON.stringify(
      {
        findings: validated.findings,
        dropped: validated.dropped,
        omittedSections: gallery.omittedSections,
      },
      null,
      2,
    ) + "\n",
  );
  const counts = { defect: 0, major: 0, minor: 0 };
  for (const x of validated.findings) counts[x.severity]++;
  return {
    ran: true,
    findingsPath: out,
    counts,
    dropped: validated.dropped,
    omittedSections: gallery.omittedSections,
    total_cost_usd: envelope.total_cost_usd,
  };
}
