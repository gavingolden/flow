import { describe, expect, it } from "vitest";
import {
  PIPELINE_SKILL_DIR,
  parseDispatchTable,
  parseReferenceIndex,
  readPipelineSkillCore,
  readPipelineSkillCorpus,
  readPipelineSkillDoc,
} from "./pipeline-skill-corpus";

const CORE = [
  "# Goal",
  "",
  "## Phase dispatch",
  "",
  "| Step | Phases written | Non-negotiable | Doc |",
  "|---|---|---|---|",
  "| 1 — Triage | `triaging`, `triaged-no-change` | classify first | `references/phases/step-01-triage.md` |",
  "| 3 — Plan | `planning` | route by helper | `references/phases/step-03-plan.md`; read with `references/phases/shared-gate-contracts.md` |",
  "",
  "## On-demand references",
  "",
  "| Doc | Read when |",
  "|---|---|",
  "| `references/phases/resume.md` | resuming a run |",
  "| `references/pause-output-contract.md` | rendering a pause |",
  "",
  "## After a compaction or resume",
].join("\n");

describe("parseDispatchTable", () => {
  it("returns step, backticked phases and the primary phase doc per row", () => {
    expect(parseDispatchTable(CORE)).toEqual([
      {
        step: "1 — Triage",
        phases: ["triaging", "triaged-no-change"],
        doc: "references/phases/step-01-triage.md",
      },
      {
        step: "3 — Plan",
        phases: ["planning"],
        doc: "references/phases/step-03-plan.md",
      },
    ]);
  });

  it("stops at the next heading and tolerates a missing table", () => {
    expect(parseDispatchTable("# Goal\n\ntext")).toEqual([]);
  });
});

describe("parseReferenceIndex", () => {
  it("returns the doc path and the when-cell per row", () => {
    expect(parseReferenceIndex(CORE)).toEqual([
      { doc: "references/phases/resume.md", when: "resuming a run" },
      {
        doc: "references/pause-output-contract.md",
        when: "rendering a pause",
      },
    ]);
  });
});

describe("readPipelineSkillCorpus", () => {
  it("contains the whole core and the docs it reads from disk", () => {
    const core = readPipelineSkillCore();
    const corpus = readPipelineSkillCorpus();
    expect(corpus.startsWith(core)).toBe(true);
    for (const row of parseDispatchTable(core))
      if (row.doc) expect(corpus).toContain(readPipelineSkillDoc(row.doc));
  });

  it("points at the real skill directory", () => {
    expect(readPipelineSkillDoc("SKILL.md")).toContain("name: flow-pipeline");
    expect(PIPELINE_SKILL_DIR.endsWith("skills/pipeline/flow-pipeline")).toBe(
      true,
    );
  });
});
