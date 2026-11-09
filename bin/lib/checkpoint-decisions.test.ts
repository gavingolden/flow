import { describe, expect, it } from "vitest";
import {
  classifyDecisions,
  parseNoteItems,
  type DecisionNote,
} from "./checkpoint-decisions";

function note(
  n: number,
  body: string,
  extra: Partial<DecisionNote> = {},
): DecisionNote {
  return {
    at: `2026-11-0${n}T00:00:00Z`,
    phase: "implementing",
    site: "manual",
    sha: `sha${n}`,
    items: parseNoteItems(body),
    ...extra,
  };
}

const live = { liveNoteSha: null, liveNoteUsable: false, pipelineEnded: false };

describe("parseNoteItems", () => {
  it("should return one one-time item holding an untagged body verbatim", () => {
    // Arrange / Act
    const items = parseNoteItems("approved with the rename\nand keep tests\n");
    // Assert
    expect(items).toEqual([
      { tag: "one-time", text: "approved with the rename\nand keep tests" },
    ]);
  });

  it("should yield no items for an empty body", () => {
    expect(parseNoteItems("  \n\n")).toEqual([]);
  });

  it("should parse tags and join indented continuation lines", () => {
    const items = parseNoteItems(
      [
        "- [standing] skip the Copilot wait",
        "  until review is green",
        "- [one-time] approve",
        "- [revoke S2] drop it",
      ].join("\n"),
    );
    expect(items).toEqual([
      { tag: "standing", text: "skip the Copilot wait\nuntil review is green" },
      { tag: "one-time", text: "approve" },
      { tag: "revoke", revokes: "S2", text: "drop it" },
    ]);
  });

  it("should gather untagged lines into one trailing one-time item", () => {
    const items = parseNoteItems("intro\n- [standing] rule\nouttro");
    expect(items).toEqual([
      { tag: "standing", text: "rule" },
      { tag: "one-time", text: "intro\nouttro" },
    ]);
  });
});

describe("classifyDecisions", () => {
  it("should keep a standing item active and retire the one-time item", () => {
    const n1 = note(1, "- [standing] wait for Copilot\n- [one-time] approve");
    const { active, record } = classifyDecisions([n1], live);
    expect(active.map((c) => c.id)).toEqual(["S1"]);
    expect(record).toHaveLength(1);
    expect(record[0].status).toBe("retired");
  });

  it("should move a revoked standing item to the record", () => {
    const n1 = note(1, "- [standing] wait for Copilot");
    const n2 = note(2, "- [revoke S1] stop waiting");
    const { active, record } = classifyDecisions([n1, n2], live);
    expect(active).toEqual([]);
    const revoked = record.find((r) => r.status === "revoked");
    expect(revoked?.id).toBe("S1");
    expect(revoked?.revokedBy).toBe(n2.at);
    expect(record.find((r) => r.item.tag === "revoke")?.status).toBe(
      "record-only",
    );
  });

  it("should share one id between identical standing texts", () => {
    const n1 = note(1, "- [standing] wait   for Copilot");
    const n2 = note(2, "- [standing] wait for Copilot\n- [standing] other");
    const { active } = classifyDecisions([n1, n2], live);
    expect(active.map((c) => c.id)).toEqual(["S1", "S1", "S2"]);
  });

  it("should record a revoke of an unknown id without effect", () => {
    const n1 = note(1, "- [standing] rule");
    const n2 = note(2, "- [revoke S9] nothing");
    const { active, record } = classifyDecisions([n1, n2], live);
    expect(active.map((c) => c.id)).toEqual(["S1"]);
    expect(record[0].status).toBe("record-only");
  });

  it("should keep one-time items of a usable live note active", () => {
    const n1 = note(1, "- [one-time] approve");
    const { active } = classifyDecisions([n1], {
      liveNoteSha: n1.sha,
      liveNoteUsable: true,
      pipelineEnded: false,
    });
    expect(active).toHaveLength(1);
  });

  it("should retire one-time items of a live but unusable note", () => {
    const n1 = note(1, "- [one-time] approve");
    const { active, record } = classifyDecisions([n1], {
      liveNoteSha: n1.sha,
      liveNoteUsable: false,
      pipelineEnded: false,
    });
    expect(active).toEqual([]);
    expect(record[0].status).toBe("retired");
  });

  it("should mark older one-time items superseded", () => {
    const n1 = note(1, "- [one-time] a");
    const n2 = note(2, "- [one-time] b");
    const { record } = classifyDecisions([n1, n2], live);
    expect(record.map((r) => r.status)).toEqual(["superseded", "retired"]);
  });

  it("should have no active instructions once the pipeline ended", () => {
    const n1 = note(1, "- [standing] rule\n- [one-time] approve");
    const { active, record } = classifyDecisions([n1], {
      liveNoteSha: n1.sha,
      liveNoteUsable: true,
      pipelineEnded: true,
    });
    expect(active).toEqual([]);
    expect(record.map((r) => r.status)).toEqual(["ended", "ended"]);
  });
});
