import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManagerLog } from "./manager-log";
import {
  addProposal,
  answerProposal,
  readProposals,
  type Proposal,
} from "./manager-proposals";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mprop-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p-000001",
  kind: "epic-change",
  repo: "flow",
  epic: "e",
  text: "cut f4",
  recommendation: "approve",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

describe("proposals store", () => {
  it("reads a missing or malformed file as empty and skips bad entries", () => {
    expect(readProposals(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, "proposals.json"), "{nope");
    expect(readProposals(dir)).toEqual([]);
    fs.writeFileSync(
      path.join(dir, "proposals.json"),
      JSON.stringify({
        version: 1,
        proposals: [proposal(), { id: "x", kind: "other" }],
      }),
    );
    expect(readProposals(dir).map((p) => p.id)).toEqual(["p-000001"]);
  });

  it("adds proposals and replaces one with the same id", () => {
    addProposal(proposal(), dir);
    addProposal(
      proposal({ id: "p-000002", kind: "stale-cancel", slug: "s" }),
      dir,
    );
    addProposal(proposal({ text: "cut f5" }), dir);
    const all = readProposals(dir);
    expect(all.map((p) => p.id).sort()).toEqual(["p-000001", "p-000002"]);
    expect(all.find((p) => p.id === "p-000001")?.text).toBe("cut f5");
  });

  it("answering removes the proposal and logs a proposal-answered line carrying repo, epic and the answer", () => {
    addProposal(proposal(), dir);
    addProposal(proposal({ id: "p-000002" }), dir);
    const now = new Date("2026-11-02T00:00:00.000Z");
    expect(answerProposal("p-000001", "approve", now, dir)).toBe(true);
    expect(readProposals(dir).map((p) => p.id)).toEqual(["p-000002"]);
    const log = readManagerLog({ epic: "e" }, dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "proposal-answered",
      repo: "flow",
      epic: "e",
      reason: "approve",
      ts: "2026-11-02T00:00:00.000Z",
    });
  });

  it("answering an unknown or already-answered id returns false and logs nothing", () => {
    addProposal(proposal(), dir);
    expect(answerProposal("nope", "approve", new Date(), dir)).toBe(false);
    answerProposal("p-000001", "approve", new Date(), dir);
    expect(answerProposal("p-000001", "approve", new Date(), dir)).toBe(false);
    expect(readManagerLog({ repo: "flow" }, dir)).toHaveLength(1);
  });
});
