import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./flow-review-collect";
import { runCollect } from "./lib/review-collect";

const FINDING = {
  file: "src/a.ts",
  line: 4,
  label: "issue",
  decoration: "blocking",
  confidence: 90,
  subject: "SECRET-SUBJECT-TEXT",
  body: "SECRET-BODY-TEXT",
};

const CONSOLIDATOR = {
  consolidated_findings: [FINDING],
  dropped_by_validation: [],
  rejected_alternatives: ["x"],
  anti_patterns_found: ["y"],
  summary: "consolidated",
};

const FIX_APPLIER = (status: "partial" | "complete") => ({
  status,
  commits: [
    {
      sha: "a1b2c3d",
      files: ["src/a.ts"],
      finding_id: "f-1",
      reasoning: "fixed it",
      verify_status: "pass",
      comment_ids: ["c-1"],
    },
  ],
  deferred: [],
  rejected_alternatives: [],
  anti_patterns_found: [],
  summary: "did the work",
});

const MANDATORY = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
];

let worktree: string;
let tmp: string;

function write(name: string, body: unknown): void {
  fs.writeFileSync(
    path.join(tmp, name),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

function clock(onSleep?: (totalMs: number) => void) {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      onSleep?.(t - 1_000_000);
    },
  };
}

function scope(
  runLenses: string[],
  kind: "full" | "delta" = "full",
): Record<string, unknown> {
  const gates: Record<string, { run: boolean }> = {};
  for (const l of [...MANDATORY, "product"]) {
    gates[l] = { run: runLenses.includes(l) };
  }
  return { version: 1, scope: kind, gates };
}

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "review-collect-"));
  tmp = path.join(worktree, ".flow-tmp");
  fs.mkdirSync(tmp);
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe("lenses stage", () => {
  it("is ready with per-lens counts only — never finding text", async () => {
    write("review-scope.json", scope(MANDATORY));
    for (const l of MANDATORY)
      write(`agent-output-${l}.json`, { findings: [FINDING] });
    write("intent-guess.json", {
      guessed_purpose: "p",
      key_changes: [],
      justification: "j",
      confidence: 80,
    });
    const c = clock();
    const { envelope, exitCode } = await runCollect({
      stage: "lenses",
      worktree,
      waitSec: 30,
      ...c,
    });
    expect(exitCode).toBe(0);
    expect(envelope.ready).toBe(true);
    expect(envelope.waitedSec).toBe(0);
    const digest = envelope.digest as { lens: string; findingCount: number }[];
    expect(digest.find((d) => d.lens === "security")).toEqual({
      lens: "security",
      present: true,
      valid: true,
      findingCount: 1,
    });
    const out = JSON.stringify(envelope);
    expect(out).not.toContain("SECRET-SUBJECT-TEXT");
    expect(out).not.toContain("SECRET-BODY-TEXT");
  });

  it("derives expected lenses from review-scope gates (gated-off lens is not waited for)", async () => {
    write("review-scope.json", scope(["bug-detection", "test-coverage"]));
    write("agent-output-bug-detection.json", { findings: [] });
    write("agent-output-test-coverage.json", { findings: [] });
    write("intent-guess.json", {
      guessed_purpose: "p",
      key_changes: [],
      justification: "j",
      confidence: 80,
    });
    const { envelope, exitCode } = await runCollect({
      stage: "lenses",
      worktree,
      waitSec: 30,
      ...clock(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.waitedSec).toBe(0);
    expect(
      (envelope.digest as { lens: string }[]).map((d) => d.lens).sort(),
    ).toEqual(["bug-detection", "intent-guess", "test-coverage"]);
  });

  it("waits for product only when gated to run", async () => {
    write("review-scope.json", scope(["bug-detection", "product"], "delta"));
    write("agent-output-bug-detection.json", { findings: [] });
    const { exitCode, envelope } = await runCollect({
      stage: "lenses",
      worktree,
      waitSec: 10,
      ...clock(),
    });
    expect(exitCode).toBe(3);
    expect(
      (envelope.digest as { lens: string; present: boolean }[]).find(
        (d) => d.lens === "product",
      )?.present,
    ).toBe(false);
  });

  it("skips intent-guess on delta scope", async () => {
    write("review-scope.json", scope(["bug-detection"], "delta"));
    write("agent-output-bug-detection.json", { findings: [] });
    const { envelope, exitCode } = await runCollect({
      stage: "lenses",
      worktree,
      waitSec: 30,
      ...clock(),
    });
    expect(exitCode).toBe(0);
    expect(
      (envelope.digest as { lens: string }[]).some(
        (d) => d.lens === "intent-guess",
      ),
    ).toBe(false);
  });

  it("falls back to the six mandatory lenses without review-scope.json", async () => {
    for (const l of MANDATORY.slice(0, 5))
      write(`agent-output-${l}.json`, { findings: [] });
    const { exitCode } = await runCollect({
      stage: "lenses",
      worktree,
      waitSec: 10,
      ...clock(),
    });
    expect(exitCode).toBe(3);
  });

  it("reports an invalid lens valid:false with exit 0 (the consolidator owns validation)", async () => {
    write("review-scope.json", scope(["bug-detection"], "delta"));
    write("agent-output-bug-detection.json", { nope: true });
    const { envelope, exitCode } = await runCollect({
      stage: "lenses",
      worktree,
      waitSec: 30,
      ...clock(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.escalationTag).toBeNull();
    expect((envelope.digest as { valid: boolean }[])[0].valid).toBe(false);
  });
});

describe("consolidator stage", () => {
  it("valid → exit 0 with the full object as the digest", async () => {
    write("consolidator-result.json", CONSOLIDATOR);
    const { envelope, exitCode } = await runCollect({
      stage: "consolidator",
      worktree,
      waitSec: 0,
      ...clock(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.valid).toBe(true);
    expect(envelope.digest).toEqual(CONSOLIDATOR);
    expect(
      (envelope.digest as { consolidated_findings: { body: string }[] })
        .consolidated_findings[0].body,
    ).toBe("SECRET-BODY-TEXT");
  });

  it("schema-invalid → exit 1 consolidator-schema-failure", async () => {
    write("consolidator-result.json", { consolidated_findings: "nope" });
    const { envelope, exitCode } = await runCollect({
      stage: "consolidator",
      worktree,
      waitSec: 0,
      ...clock(),
    });
    expect(exitCode).toBe(1);
    expect(envelope.ready).toBe(true);
    expect(envelope.valid).toBe(false);
    expect(envelope.escalationTag).toBe("consolidator-schema-failure");
  });

  it("missing with --wait-sec 0 → exit 1 consolidator-missing-artifact", async () => {
    const { envelope, exitCode } = await runCollect({
      stage: "consolidator",
      worktree,
      waitSec: 0,
      ...clock(),
    });
    expect(exitCode).toBe(1);
    expect(envelope.ready).toBe(false);
    expect(envelope.escalationTag).toBe("consolidator-missing-artifact");
  });

  it("unparseable JSON counts as not-yet-written while waiting (exit 3)", async () => {
    write("consolidator-result.json", "{ half-writ");
    const { envelope, exitCode } = await runCollect({
      stage: "consolidator",
      worktree,
      waitSec: 10,
      ...clock(),
    });
    expect(exitCode).toBe(3);
    expect(envelope.escalationTag).toBeNull();
    expect(envelope.waitedSec).toBe(10);
  });
});

describe("fix-applier stage", () => {
  it("missing with --wait-sec 0 → exit 1 fix-applier-missing-artifact", async () => {
    const { envelope, exitCode } = await runCollect({
      stage: "fix-applier",
      worktree,
      waitSec: 0,
      ...clock(),
    });
    expect(exitCode).toBe(1);
    expect(envelope.escalationTag).toBe("fix-applier-missing-artifact");
  });

  it("step-0 skeleton (partial) while waiting → not ready → exit 3 after the wait", async () => {
    write("fix-applier-result.json", FIX_APPLIER("partial"));
    const { envelope, exitCode } = await runCollect({
      stage: "fix-applier",
      worktree,
      waitSec: 12,
      ...clock(),
    });
    expect(exitCode).toBe(3);
    expect(envelope.ready).toBe(false);
    expect(envelope.escalationTag).toBeNull();
    expect(envelope.waitedSec).toBe(12);
  });

  it("partial with --wait-sec 0 → ready+valid exit 0 so the supervisor routes the continuation", async () => {
    write("fix-applier-result.json", FIX_APPLIER("partial"));
    const { envelope, exitCode } = await runCollect({
      stage: "fix-applier",
      worktree,
      waitSec: 0,
      ...clock(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.ready).toBe(true);
    expect((envelope.digest as { status: string }).status).toBe("partial");
  });

  it("complete → exit 0 with the full object (singular finding_id, comment_ids)", async () => {
    write("fix-applier-result.json", FIX_APPLIER("complete"));
    const { envelope, exitCode } = await runCollect({
      stage: "fix-applier",
      worktree,
      waitSec: 30,
      ...clock(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.digest).toEqual(FIX_APPLIER("complete"));
  });

  it("complete but schema-invalid → exit 1 fix-applier-missing-artifact", async () => {
    write("fix-applier-result.json", { status: "complete", commits: [] });
    const { envelope, exitCode } = await runCollect({
      stage: "fix-applier",
      worktree,
      waitSec: 30,
      ...clock(),
    });
    expect(exitCode).toBe(1);
    expect(envelope.valid).toBe(false);
    expect(envelope.escalationTag).toBe("fix-applier-missing-artifact");
  });

  it("an artifact appearing mid-wait → exit 0 with waitedSec > 0", async () => {
    const c = clock((total) => {
      if (total >= 15_000)
        write("fix-applier-result.json", FIX_APPLIER("complete"));
    });
    const { envelope, exitCode } = await runCollect({
      stage: "fix-applier",
      worktree,
      waitSec: 60,
      ...c,
    });
    expect(exitCode).toBe(0);
    expect(envelope.waitedSec).toBe(15);
  });
});

describe("CLI", () => {
  it("rejects bad args with exit 2", async () => {
    expect(parseArgs([])).toEqual({ error: "--stage is required" });
    expect(parseArgs(["--stage", "bogus", "--worktree", "/x"])).toEqual({
      error: "invalid --stage value: bogus",
    });
    expect(parseArgs(["--stage", "lenses"])).toEqual({
      error: "--worktree is required",
    });
    expect(
      parseArgs(["--stage", "lenses", "--worktree", "/x", "--wait-sec", "-1"]),
    ).toEqual({ error: "invalid --wait-sec value: -1" });
    expect(await run(["--nope"])).toBe(2);
  });

  it("defaults --wait-sec to 540", () => {
    expect(parseArgs(["--stage", "lenses", "--worktree", "/x"])).toEqual({
      stage: "lenses",
      worktree: "/x",
      waitSec: 540,
    });
  });

  it("prints the envelope and returns the exit code", async () => {
    const writes: string[] = [];
    const orig = console.log;
    console.log = (s: string) => {
      writes.push(s);
    };
    try {
      const code = await run([
        "--stage",
        "consolidator",
        "--worktree",
        worktree,
        "--wait-sec",
        "0",
      ]);
      expect(code).toBe(1);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(writes[0]).escalationTag).toBe(
      "consolidator-missing-artifact",
    );
  });
});
