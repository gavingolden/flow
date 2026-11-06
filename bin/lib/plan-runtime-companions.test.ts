import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkQueueCompanions, checkRecovery } from "./plan-runtime-companions";

const plan = (tasks: string, prdExtra = ""): string =>
  `# PRD\n\n### Runtime design\n${prdExtra}\n\n# Task breakdown\n\n${tasks}\n`;

const queue = (t: string): string[] => {
  const m: string[] = [];
  checkQueueCompanions(t, m);
  return m;
};
const recovery = (t: string): string[] => {
  const m: string[] = [];
  checkRecovery(t, m);
  return m;
};

describe("checkQueueCompanions", () => {
  it("flags SQS without a visibility timeout", () => {
    const m = queue(plan("- Create the SQS queue with a dead-letter queue."));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/visibility timeout/);
  });
  it("passes SQS with both settings", () => {
    expect(
      queue(plan("- Create SQS with visibility timeout 90s and a DLQ.")),
    ).toEqual([]);
  });
  it("passes Cloud Tasks with deadline and attempts", () => {
    expect(
      queue(plan("- Cloud Tasks queue: dispatch deadline 60s, 5 attempts.")),
    ).toEqual([]);
  });
  it("flags Cloudflare Queues without a DLQ", () => {
    const m = queue(plan("- Add a Cloudflare Queue consumer."));
    expect(m[0]).toMatch(/dead-letter queue/);
  });
  it("ignores a service named outside the Task breakdown", () => {
    const t = `# PRD\n\nUses SQS.\n\n# Task breakdown\n\n- Write docs.\n`;
    expect(queue(t)).toEqual([]);
  });
  it("is silent with no Task breakdown", () => {
    expect(queue("# PRD\n\nSQS everywhere.\n")).toEqual([]);
  });
});

describe("checkRecovery — store detection", () => {
  it("ignores token-bucket mentions as a datastore", () => {
    const m = recovery(
      plan(
        "- Add migration and a token bucket rate limiter; enable PITR and verify a restore.",
        "**Recovery:** PITR",
      ),
    );
    expect(m).toEqual([]);
  });
  it("flags a dual-store plan where only database backups exist", () => {
    const m = recovery(
      plan(
        "- Add migration; enable automated database backups.\n- Create a bucket for uploads.\n- Verify a restore.",
        "**Recovery:** backups",
      ),
    );
    expect(m.join("\n")).toMatch(/bucket/);
  });
});

describe("checkRecovery", () => {
  it("flags a migration with no Recovery line", () => {
    expect(recovery(plan("- Add a migration for jobs."))[0]).toMatch(
      /no '\*\*Recovery:\*\*' line/,
    );
  });
  it("flags none with no reason", () => {
    const m = recovery(plan("- Add a migration.", "**Recovery:** none"));
    expect(m[0]).toMatch(/no reason/);
  });
  it("accepts none with a covered reason on an existing table", () => {
    expect(
      recovery(
        plan(
          "- Add a migration adding status columns.",
          "**Recovery:** none — status columns on an existing table already covered by its backups",
        ),
      ),
    ).toEqual([]);
  });
  it("flags none on a new table without a regenerable reason", () => {
    const m = recovery(
      plan("- Create table reports.", "**Recovery:** none — keeps forever"),
    );
    expect(m[0]).toMatch(/new table or bucket/);
  });
  it("flags a recovery path with no backup task", () => {
    const m = recovery(
      plan(
        "- Add a migration; restore drill.",
        "**Recovery:** nightly dump plus a restore check",
      ),
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/backups/);
  });
  it("passes a recovery path with backup and restore tasks", () => {
    expect(
      recovery(
        plan(
          "- Add a migration; enable PITR backups.\n- Run a restore check.",
          "**Recovery:** PITR plus a restore check",
        ),
      ),
    ).toEqual([]);
  });
  it("is silent with no datastore words", () => {
    expect(recovery(plan("- Rename a button."))).toEqual([]);
  });
  it("flags a new table covered only by versioning, backups left in Open Questions", () => {
    const m = recovery(
      plan(
        "- Create table contracts.\n- Turn on bucket versioning.\n- Run a restore check.",
        "**Recovery:** backups plus a restore check\n\n## Open Questions\n- Are backups enabled?",
      ),
    );
    expect(m.some((x) => /database/.test(x))).toBe(true);
  });
  it("passes a new table with a verify-PITR-on task", () => {
    expect(
      recovery(
        plan(
          "- Create table contracts.\n- Verify PITR is on; enable it if not.\n- Run a restore check.",
          "**Recovery:** PITR plus a restore check",
        ),
      ),
    ).toEqual([]);
  });
  it("passes a bucket-only change covered by versioning", () => {
    expect(
      recovery(
        plan(
          "- Add a bucket with versioning on.\n- Run a restore check.",
          "**Recovery:** object versioning plus a restore check",
        ),
      ),
    ).toEqual([]);
  });
  it("requires both stores covered in a dual-store plan", () => {
    const m = recovery(
      plan(
        "- Create table contracts and a bucket; enable PITR.\n- Run a restore check.",
        "**Recovery:** PITR plus a restore check",
      ),
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/bucket/);
  });
  it("flags the kept r4-recovery eval plan", () => {
    const text = readFileSync(
      "docs/eval/system-design-references/with-refs-v2/r4-recovery/run-1/plan.md",
      "utf8",
    );
    expect(recovery(text).some((x) => /database/.test(x))).toBe(true);
  });
});
