/**
 * Open proposals the manager waits on the owner for: `~/.flow/manager/proposals.json`.
 * Answering removes the proposal and appends a `proposal-answered` log line,
 * so the file only ever holds what is still open. No CLI ships with this
 * store; its callers arrive with the manager agent.
 */

import * as fs from "node:fs";
import { withFileLockSync } from "./lock";
import {
  managerFile,
  managerHome,
  managerLockPath,
  writeJsonAtomic,
} from "./manager-home";
import { appendManagerLog } from "./manager-log";

export type ProposalKind = "epic-change" | "stale-cancel" | "interview-draft";

export type Proposal = {
  id: string;
  kind: ProposalKind;
  repo: string;
  slug?: string;
  epic?: string;
  text: string;
  recommendation?: string;
  createdAt: string;
};

const KINDS: readonly string[] = [
  "epic-change",
  "stale-cancel",
  "interview-draft",
];

/** The generator's format (`p-` + 6 hex); a planted id such as "" never reads back. */
const PROPOSAL_ID = /^p-[0-9a-f]{6}$/;

function proposalsPath(home?: string): string {
  return managerFile("proposals.json", home ?? managerHome());
}

function isProposal(v: unknown): v is Proposal {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    PROPOSAL_ID.test(p.id) &&
    typeof p.kind === "string" &&
    KINDS.includes(p.kind) &&
    typeof p.repo === "string" &&
    typeof p.text === "string" &&
    typeof p.createdAt === "string" &&
    (p.slug === undefined || typeof p.slug === "string") &&
    (p.epic === undefined || typeof p.epic === "string") &&
    (p.recommendation === undefined || typeof p.recommendation === "string")
  );
}

/** Tolerant: a missing file reads as none; an invalid entry is skipped. */
export function readProposals(home?: string): Proposal[] {
  try {
    const v = JSON.parse(fs.readFileSync(proposalsPath(home), "utf8")) as {
      version?: unknown;
      proposals?: unknown;
    };
    if (v?.version !== 1 || !Array.isArray(v.proposals)) return [];
    return v.proposals.filter(isProposal);
  } catch {
    return [];
  }
}

function locked<T>(home: string | undefined, fn: () => T): T {
  return withFileLockSync(
    managerLockPath("proposals", home ?? managerHome()),
    fn,
  );
}

function write(proposals: Proposal[], home?: string): void {
  writeJsonAtomic(proposalsPath(home), { version: 1, proposals });
}

/** One entry per id: re-adding an id replaces it. */
export function addProposal(p: Proposal, home?: string): void {
  locked(home, () => {
    const all = readProposals(home).filter((x) => x.id !== p.id);
    write([...all, p], home);
  });
}

/** Removes the proposal and logs the owner's answer; false when no such proposal is open. */
export function answerProposal(
  id: string,
  answer: string,
  now: Date,
  home?: string,
): boolean {
  const answered = locked(home, () => {
    const all = readProposals(home);
    const p = all.find((x) => x.id === id);
    if (!p) return null;
    write(
      all.filter((x) => x.id !== id),
      home,
    );
    return p;
  });
  if (!answered) return false;
  appendManagerLog(
    {
      ts: now.toISOString(),
      kind: "proposal-answered",
      repo: answered.repo,
      ...(answered.epic ? { epic: answered.epic } : {}),
      ...(answered.slug ? { slug: answered.slug } : {}),
      key: `proposal-answered:${id}`,
      reason: answer,
    },
    { home },
  );
  return true;
}
