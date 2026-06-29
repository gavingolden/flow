import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decideNote, insertNote } from "./flow-research-note";

const SCRIPT = path.resolve(__dirname, "flow-research-note.ts");
const NOTE_RE = /Web-grounded research \(discovery Step 1\.5\)/;

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-research-note-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- decideNote (pure core) -----------------------------------------------

describe(decideNote, () => {
  it("(a) returns null when the path is dormant (active=false)", () => {
    expect(
      decideNote({
        active: false,
        forced: false,
        status: null,
        planText: "# PRD\n",
      }),
    ).toBeNull();
  });

  it("(b) returns null when research actually ran (status.ran=true)", () => {
    expect(
      decideNote({
        active: true,
        forced: false,
        status: { ran: true, reason: "ran" },
        planText: "# PRD\n",
      }),
    ).toBeNull();
  });

  it("(c) emits the not-researchable wording from status.reason", () => {
    const d = decideNote({
      active: true,
      forced: false,
      status: { ran: false, reason: "not-researchable" },
      planText: "# PRD\n",
    });
    expect(d).not.toBeNull();
    expect(d!.noteLine).toContain("not a researchable question");
    expect(d!.insertedText).toContain("> [!NOTE]");
  });

  it("emits the agy-unavailable wording from status.reason", () => {
    const d = decideNote({
      active: true,
      forced: false,
      status: { ran: false, reason: "agy-unavailable" },
      planText: "# PRD\n",
    });
    expect(d!.noteLine).toContain("agy unavailable on this host");
  });

  it("(d) emits the generic 'did not run' note when no status file (forced=false)", () => {
    const d = decideNote({
      active: true,
      forced: false,
      status: null,
      planText: "# PRD\n",
    });
    expect(d!.noteLine).toContain("did not run");
  });

  it("(e) emits the 'forced on, but no research ran' note when no status file (forced=true)", () => {
    const d = decideNote({
      active: true,
      forced: true,
      status: null,
      planText: "# PRD\n",
    });
    expect(d!.noteLine).toContain("forced on, but no research ran");
  });

  it("(f) is idempotent: echoes the existing note line, signals no insert", () => {
    const existing =
      "# PRD\n\n> [!NOTE]\n> Web-grounded research (discovery Step 1.5): skipped — agy unavailable on this host; force with `flow new --research`.\n\nbody\n";
    const d = decideNote({
      active: true,
      forced: false,
      status: null,
      planText: existing,
    });
    expect(d!.insertedText).toBeNull();
    expect(d!.noteLine).toContain("agy unavailable on this host");
    expect(d!.noteLine.startsWith(">")).toBe(false);
  });
});

// --- insertNote (placement) -----------------------------------------------

describe(insertNote, () => {
  it("(g) inserts the note immediately after the first `# PRD` heading", () => {
    const out = insertNote("# PRD\n\nproblem statement\n", "> [!NOTE]\n> x");
    const lines = out.split("\n");
    expect(lines[0]).toBe("# PRD");
    expect(lines[2]).toBe("> [!NOTE]");
  });

  it("prepends when there is no `# PRD` heading", () => {
    const out = insertNote("just text\n", "> [!NOTE]\n> x");
    expect(out.startsWith("> [!NOTE]\n> x\n\n")).toBe(true);
  });
});

// --- CLI smoke tests (exit 0 on every operational path) -------------------

describe("flow-research-note CLI", () => {
  it("dormant: no config, not forced → no output, plan unchanged, exit 0", () => {
    withTmp((dir) => {
      const plan = path.join(dir, "plan.md");
      const cfg = path.join(dir, "config.json");
      writeFileSync(plan, "# PRD\n\nbody\n");
      writeFileSync(cfg, "{}");
      const r = runCli([
        "ensure",
        "--plan-file",
        plan,
        "--forced",
        "false",
        "--config",
        cfg,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(readFileSync(plan, "utf8")).toBe("# PRD\n\nbody\n");
    });
  });

  it("forced + status ran=true → no note, plan unchanged, exit 0", () => {
    withTmp((dir) => {
      const plan = path.join(dir, "plan.md");
      const status = path.join(dir, "research-status.json");
      writeFileSync(plan, "# PRD\n\nbody\n");
      writeFileSync(
        status,
        JSON.stringify({ active: true, ran: true, reason: "ran" }),
      );
      const r = runCli(["ensure", "--plan-file", plan, "--forced", "true"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(readFileSync(plan, "utf8")).toBe("# PRD\n\nbody\n");
    });
  });

  it("forced + no status file → inserts 'forced on' note, echoes it, exit 0", () => {
    withTmp((dir) => {
      const plan = path.join(dir, "plan.md");
      writeFileSync(plan, "# PRD\n\nbody\n");
      const r = runCli(["ensure", "--plan-file", plan, "--forced", "true"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("forced on, but no research ran");
      const after = readFileSync(plan, "utf8");
      expect(NOTE_RE.test(after)).toBe(true);
      expect(after.split("\n")[2]).toBe("> [!NOTE]");
    });
  });

  it("active-via-config + not-researchable status → inserts note, exit 0", () => {
    withTmp((dir) => {
      const plan = path.join(dir, "plan.md");
      const cfg = path.join(dir, "config.json");
      const status = path.join(dir, "research-status.json");
      writeFileSync(plan, "# PRD\n\nbody\n");
      writeFileSync(cfg, JSON.stringify({ research: { discovery: true } }));
      writeFileSync(
        status,
        JSON.stringify({
          active: true,
          ran: false,
          reason: "not-researchable",
        }),
      );
      const r = runCli(["ensure", "--plan-file", plan, "--config", cfg]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("not a researchable question");
      expect(NOTE_RE.test(readFileSync(plan, "utf8"))).toBe(true);
    });
  });

  it("idempotent: an existing note is not duplicated, existing line echoed, exit 0", () => {
    withTmp((dir) => {
      const plan = path.join(dir, "plan.md");
      const original =
        "# PRD\n\n> [!NOTE]\n> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow new --research`.\n\nbody\n";
      writeFileSync(plan, original);
      const r = runCli(["ensure", "--plan-file", plan, "--forced", "true"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("not a researchable question");
      const after = readFileSync(plan, "utf8");
      expect(after).toBe(original);
      const matches = after.split("\n").filter((l) => NOTE_RE.test(l)).length;
      expect(matches).toBe(1);
    });
  });
});
