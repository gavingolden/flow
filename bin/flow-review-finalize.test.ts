import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./flow-review-finalize";
import {
  ghSupportsAttach,
  runReviewFinalize,
  type ExecResult,
  type ReviewFinalize,
  type ReviewFinalizeOptions,
} from "./lib/review-finalize";

let worktree!: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(
    path.join(os.tmpdir(), "flow-review-finalize-test-"),
  );
  fs.mkdirSync(path.join(worktree, ".flow-tmp"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".flow-tmp", "body.md"),
    "## Summary\nfresh body\n",
  );
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

const OK = { stderr: "", exitCode: 0 } as const;

function fixApplierResultJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    commits: [],
    deferred: [],
    rejected_alternatives: [],
    anti_patterns_found: [],
    summary: "ok",
    ...extra,
  });
}

/** Injectable-subprocess fake with a call log — never touches real gh/network. */
function makeExec(
  calls: string[][],
  opts: {
    lensModelSupported?: boolean;
    telemetryFails?: boolean;
    bodyEditFails?: boolean;
    untrackedGuardFails?: boolean;
  } = {},
  cwds: (string | undefined)[] = [],
) {
  return (argv: string[], execOpts?: { cwd?: string }): ExecResult => {
    calls.push(argv);
    cwds.push(execOpts?.cwd);
    const [cmd, sub] = argv;
    if (cmd === "flow-md-validate") return { stdout: "", ...OK };
    if (cmd === "gh") {
      return opts.bodyEditFails
        ? { stdout: "", stderr: "gh failed", exitCode: 1 }
        : { stdout: "", ...OK };
    }
    if (
      cmd === "flow-review-telemetry" &&
      sub === "collect" &&
      argv.includes("--lens-model") &&
      !opts.lensModelSupported
    ) {
      // Mirrors the real helper: it answers `unknown flag: <flag>` on
      // stderr AND exits 2 — a real failure also exits non-zero, so the
      // exit code alone cannot distinguish "unknown flag" from a genuine
      // failure; the caller keys off the `unknown flag:` string instead.
      return {
        stdout: "",
        stderr: "flow-review-telemetry: unknown flag: --lens-model",
        exitCode: 2,
      };
    }
    if (cmd === "flow-review-telemetry") {
      return opts.telemetryFails
        ? { stdout: "", stderr: "telemetry failed", exitCode: 1 }
        : { stdout: "", ...OK };
    }
    if (cmd === "flow-untracked" && sub === "list") {
      return opts.untrackedGuardFails
        ? { stdout: "", stderr: "no state", exitCode: 2 }
        : { stdout: "[]", ...OK };
    }
    if (cmd === "flow-untracked" && sub === "add") return { stdout: "", ...OK };
    if (cmd === "git") return { stdout: "deadbeef1234\n", ...OK };
    if (cmd === "flow-classify-step") {
      return {
        stdout: "ran 1/1 items (0 prose-promoted, 0 left manual)",
        ...OK,
      };
    }
    throw new Error(`unexpected exec call: ${argv.join(" ")}`);
  };
}

function baseOpts(
  calls: string[][],
  execOpts: Parameters<typeof makeExec>[1] = {},
  extra: Partial<ReviewFinalizeOptions> = {},
): ReviewFinalizeOptions {
  return {
    pr: 42,
    worktree,
    bodyFile: path.join(worktree, ".flow-tmp", "body.md"),
    status: "clean",
    exec: makeExec(calls, execOpts),
    ...extra,
  };
}

describe("runReviewFinalize", () => {
  it("(a) runs flow-md-validate --fix-pr-body immediately before gh pr edit --body-file, adjacent with no exec call in between", async () => {
    const calls: string[][] = [];
    await runReviewFinalize(baseOpts(calls));
    const mdIdx = calls.findIndex((c) => c[0] === "flow-md-validate");
    const ghIdx = calls.findIndex((c) => c[0] === "gh");
    expect(mdIdx).toBeGreaterThanOrEqual(0);
    expect(ghIdx).toBe(mdIdx + 1);
    expect(calls[mdIdx]).toEqual([
      "flow-md-validate",
      "--fix-pr-body",
      path.join(worktree, ".flow-tmp", "body.md"),
    ]);
    expect(calls[ghIdx]).toEqual([
      "gh",
      "pr",
      "edit",
      "42",
      "--body-file",
      path.join(worktree, ".flow-tmp", "body.md"),
    ]);
  });

  it("(b) forwards --lens-model verbatim when the installed flow-review-telemetry accepts it", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(
        calls,
        { lensModelSupported: true },
        { lensModels: ["security=alias-a", "correctness=alias-b"] },
      ),
    );
    expect(result.lens_models_forwarded).toBe(2);
    const collectCall = calls.find(
      (c) => c[0] === "flow-review-telemetry" && c[1] === "collect",
    );
    expect(collectCall).toBeDefined();
    expect(collectCall).toContain("--lens-model");
    expect(collectCall).toContain("security=alias-a");
    expect(collectCall).toContain("correctness=alias-b");
  });

  it("(c) retries without --lens-model, with a named skip, when the installed helper rejects the flag (merge-order-not-landed case)", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(
        calls,
        { lensModelSupported: false },
        { lensModels: ["security=alias-a"] },
      ),
    );
    expect(result.lens_models_forwarded).toBe(0);
    expect(result.skips).toContainEqual({
      step: "lens_models",
      reason:
        "installed flow-review-telemetry does not accept --lens-model yet; " +
        "retried without it",
    });
    // The retry must actually happen: telemetry still gets recorded, and the
    // surviving call carries no --lens-model.
    expect(result.telemetry_recorded).toBe(true);
    const collectCalls = calls.filter(
      (c) => c[0] === "flow-review-telemetry" && c[1] === "collect",
    );
    expect(collectCalls).toHaveLength(2);
    expect(collectCalls[1]).not.toContain("--lens-model");
  });

  it("(c2) does not probe or retry when no --lens-model pairs were passed", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(calls, { lensModelSupported: false }, {}),
    );
    expect(result.lens_models_forwarded).toBe(0);
    expect(result.skips.some((sk) => sk.step === "lens_models")).toBe(false);
    const collectCalls = calls.filter(
      (c) => c[0] === "flow-review-telemetry" && c[1] === "collect",
    );
    expect(collectCalls).toHaveLength(1);
  });

  it("(d) copies tier + tier_reasons through with tier_copied:true when review-scope.json carries them", async () => {
    fs.writeFileSync(
      path.join(worktree, ".flow-tmp", "review-scope.json"),
      JSON.stringify({
        scope: "full",
        tier: "standard",
        tier_reasons: ["small diff"],
      }),
    );
    const calls: string[][] = [];
    const result = await runReviewFinalize(baseOpts(calls));
    expect(result.tier_copied).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.result_artifact, "utf8"));
    expect(written.tier).toBe("standard");
    expect(written.tier_reasons).toEqual(["small diff"]);
  });

  it("(d) omits tier + tier_reasons with tier_copied:false when review-scope.json does not carry them", async () => {
    fs.writeFileSync(
      path.join(worktree, ".flow-tmp", "review-scope.json"),
      JSON.stringify({ scope: "full" }),
    );
    const calls: string[][] = [];
    const result = await runReviewFinalize(baseOpts(calls));
    expect(result.tier_copied).toBe(false);
    const written = JSON.parse(fs.readFileSync(result.result_artifact, "utf8"));
    expect("tier" in written).toBe(false);
    expect("tier_reasons" in written).toBe(false);
  });

  it("(e) sources last_sha from local `git rev-parse HEAD`, never `gh pr view`", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(baseOpts(calls));
    expect(result.last_sha).toBe("deadbeef1234");
    const gitCall = calls.find((c) => c[0] === "git");
    expect(gitCall).toEqual(["git", "rev-parse", "HEAD"]);
    expect(calls.some((c) => c[0] === "gh" && c.includes("view"))).toBe(false);
  });

  it("(e2) resolves last_sha IN the PR's worktree (cwd), not the process's own cwd", async () => {
    const calls: string[][] = [];
    const cwds: (string | undefined)[] = [];
    const result = await runReviewFinalize({
      pr: 42,
      worktree,
      bodyFile: path.join(worktree, ".flow-tmp", "body.md"),
      status: "clean",
      exec: makeExec(calls, {}, cwds),
    });
    expect(result.last_sha).toBe("deadbeef1234");
    const gitIdx = calls.findIndex((c) => c[0] === "git");
    expect(gitIdx).toBeGreaterThanOrEqual(0);
    expect(cwds[gitIdx]).toBe(worktree);
  });

  it("writes the pr-review-last-sha marker only on the clean-completion path", async () => {
    const calls: string[][] = [];
    await runReviewFinalize(baseOpts(calls, {}, { status: "clean" }));
    expect(
      fs.existsSync(path.join(worktree, ".flow-tmp", "pr-review-last-sha")),
    ).toBe(true);

    fs.rmSync(path.join(worktree, ".flow-tmp", "pr-review-last-sha"), {
      force: true,
    });
    const calls2: string[][] = [];
    await runReviewFinalize(
      baseOpts(calls2, {}, { status: "partial", missedSteps: ["13"] }),
    );
    expect(
      fs.existsSync(path.join(worktree, ".flow-tmp", "pr-review-last-sha")),
    ).toBe(false);
  });

  it("folds flow-classify-step's stdout into the result artifact's summary as the default Automation-precedence audit line", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(calls, {}, { ran: 1, total: 1, prosePromoted: 0 }),
    );
    const classifyCall = calls.find((c) => c[0] === "flow-classify-step");
    expect(classifyCall).toEqual([
      "flow-classify-step",
      "--ran",
      "1",
      "--total",
      "1",
      "--prose-promoted",
      "0",
    ]);
    const written = JSON.parse(fs.readFileSync(result.result_artifact, "utf8"));
    expect(written.summary).toBe(
      "ran 1/1 items (0 prose-promoted, 0 left manual)",
    );
  });

  it("(f) a schema-invalid artifact yields result_valid:false rather than throwing", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(calls, {}, { status: "bogus" as unknown as "clean" }),
    );
    expect(result.result_valid).toBe(false);
    expect(fs.existsSync(`${result.result_artifact}.tmp`)).toBe(true);
    expect(fs.existsSync(result.result_artifact)).toBe(false);
  });

  it("registers untracked follow-ups from fix-applier-result.json (deferred with no tracker url + non-introduced anti-patterns)", async () => {
    fs.writeFileSync(
      path.join(worktree, ".flow-tmp", "fix-applier-result.json"),
      fixApplierResultJson({
        deferred: [
          {
            finding_id: "F1",
            tracker_entry_url: "https://x/1",
            reason: "filed",
          },
          { finding_id: "F2", tracker_entry_url: "", reason: "no tracker yet" },
        ],
        anti_patterns_found: [
          {
            location: "a.ts:1",
            pattern: "pre-existing thing",
            recommendation: "fix later",
            introduced_by_this_pr: false,
          },
          {
            location: "b.ts:2",
            pattern: "new thing",
            recommendation: "n/a",
            introduced_by_this_pr: true,
          },
        ],
      }),
    );
    const calls: string[][] = [];
    const result = await runReviewFinalize(baseOpts(calls));
    expect(result.untracked_added).toBe(2);
    const addCalls = calls.filter(
      (c) => c[0] === "flow-untracked" && c[1] === "add",
    );
    expect(addCalls).toHaveLength(2);
  });

  it("skips untracked registration cleanly on a standalone run (no pipeline state)", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(calls, { untrackedGuardFails: true }),
    );
    expect(result.untracked_added).toBe(0);
    expect(result.skips).toContainEqual({
      step: "untracked",
      reason: "no pipeline state (standalone run)",
    });
  });

  it("body_updated is false and a skip is recorded when gh pr edit fails", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(calls, { bodyEditFails: true }),
    );
    expect(result.body_updated).toBe(false);
    expect(result.skips.some((s) => s.step === "body_edit")).toBe(true);
  });

  it("skips gh pr edit (never fires) when body.md is missing or empty — guards against a stale body clobbering the live PR", async () => {
    fs.writeFileSync(path.join(worktree, ".flow-tmp", "body.md"), "");
    const calls: string[][] = [];
    const result = await runReviewFinalize(baseOpts(calls));
    expect(result.body_updated).toBe(false);
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(result.skips.some((s) => s.step === "body_edit")).toBe(true);
  });

  it("forwards --lens-tokens and --widened to flow-review-telemetry collect", async () => {
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(
        calls,
        {},
        {
          lensTokens: ["security=12345", "correctness=6789"],
          widened: "consolidator asked for full scope",
        },
      ),
    );
    expect(result.lens_tokens_forwarded).toBe(2);
    const collectCall = calls.find(
      (c) => c[0] === "flow-review-telemetry" && c[1] === "collect",
    );
    expect(collectCall).toContain("--lens-tokens");
    expect(collectCall).toContain("security=12345");
    expect(collectCall).toContain("correctness=6789");
    expect(collectCall).toContain("--widened");
    expect(collectCall).toContain("consolidator asked for full scope");
  });

  it("does not overwrite an existing status:escalated result artifact, and does NOT write pr-review-last-sha either", async () => {
    fs.writeFileSync(
      path.join(worktree, ".flow-tmp", "pr-review-result.json"),
      JSON.stringify({
        status: "escalated",
        completed_steps: [],
        missed_steps: ["9"],
        escalation_tag: "intent-mismatch",
        summary: "prior escalation",
      }),
    );
    const calls: string[][] = [];
    const result = await runReviewFinalize(
      baseOpts(calls, {}, { status: "clean" }),
    );
    const written = JSON.parse(fs.readFileSync(result.result_artifact, "utf8"));
    expect(written.status).toBe("escalated");
    expect(
      fs.existsSync(path.join(worktree, ".flow-tmp", "pr-review-last-sha")),
    ).toBe(false);
  });
});

describe("screenshot attach", () => {
  const PROBE = path.resolve(__dirname, "lib/__fixtures__/attach-probe.png");
  const HOSTED = "https://github.com/user-attachments/assets/abc-123";
  const REF = "![pricing phone](.flow-tmp/ui-evidence/pricing-390.png)";
  const LOCAL_LINK = "[pricing phone (local file)](file:///w/pricing-390.png)";

  function seed(
    body = `## Test Steps\n\n- [ ] SUBJECTIVE: ok\n\n${REF}\n\n${LOCAL_LINK}\n`,
  ) {
    const dir = path.join(worktree, ".flow-tmp", "ui-evidence");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(PROBE, path.join(dir, "pricing-390.png"));
    fs.writeFileSync(path.join(worktree, ".flow-tmp", "body.md"), body);
  }

  /** Wraps makeExec: answers `gh --version` / `gh pr view`, optionally fails an --attach edit. */
  function attachExec(
    calls: string[][],
    o: { version: string; attachFails?: boolean },
  ) {
    const inner = makeExec(calls);
    return (argv: string[], execOpts?: { cwd?: string }): ExecResult => {
      if (argv[0] === "gh" && argv[1] === "--version") {
        calls.push(argv);
        return { stdout: `gh version ${o.version} (2026-09-15)\n`, ...OK };
      }
      if (argv[0] === "gh" && argv[2] === "view") {
        calls.push(argv);
        const pushed = fs.readFileSync(
          path.join(worktree, ".flow-tmp", "body.md"),
          "utf8",
        );
        return {
          stdout: pushed.replace(
            ".flow-tmp/ui-evidence/pricing-390.png",
            HOSTED,
          ),
          ...OK,
        };
      }
      if (o.attachFails && argv.includes("--attach")) {
        calls.push(argv);
        return { stdout: "", stderr: "upload failed", exitCode: 1 };
      }
      return inner(argv, execOpts);
    };
  }

  const edits = (calls: string[][]) =>
    calls.filter((c) => c[0] === "gh" && c[2] === "edit");
  const bodyPath = () => path.join(worktree, ".flow-tmp", "body.md");

  it("attach: ghSupportsAttach gates on 2.99.0", () => {
    expect(ghSupportsAttach("gh version 2.99.0 (2026-09-01)")).toBe(true);
    expect(ghSupportsAttach("gh version 2.101.0 (2026-09-15)")).toBe(true);
    expect(ghSupportsAttach("gh version 3.0.0")).toBe(true);
    expect(ghSupportsAttach("gh version 2.93.0 (2026-05-01)")).toBe(false);
    expect(ghSupportsAttach("")).toBe(false);
  });

  it("attach: a new-enough CLI gets one --attach arg per new screenshot, probed before flow-md-validate", async () => {
    seed();
    const calls: string[][] = [];
    const result = await runReviewFinalize({
      ...baseOpts(calls),
      exec: attachExec(calls, { version: "2.101.0" }),
    });
    const [edit] = edits(calls);
    expect(edit.filter((a) => a === "--attach")).toHaveLength(1);
    expect(edit[edit.indexOf("--attach") + 1]).toBe(
      `${path.join(worktree, ".flow-tmp/ui-evidence/pricing-390.png")}#pricing phone`,
    );
    const names = calls.map((c) => c.slice(0, 2).join(" "));
    expect(names.indexOf("gh --version")).toBeLessThan(
      names.indexOf("flow-md-validate --fix-pr-body"),
    );
    expect(names[names.indexOf("flow-md-validate --fix-pr-body") + 1]).toBe(
      "gh pr",
    );
    expect(result.screenshots_uploaded).toBe(1);
    expect(result.body_updated).toBe(true);
    expect(
      result.skips.filter((s) => s.step.startsWith("screenshots_")),
    ).toEqual([]);
  });

  it("attach: a second pass uploads nothing already in the ledger and pushes the hosted URL", async () => {
    seed();
    const first: string[][] = [];
    await runReviewFinalize({
      ...baseOpts(first),
      exec: attachExec(first, { version: "2.101.0" }),
    });
    const ledger = JSON.parse(
      fs.readFileSync(
        path.join(worktree, ".flow-tmp/ui-evidence/uploaded.json"),
        "utf8",
      ),
    );
    expect(Object.values(ledger)).toEqual([HOSTED]);
    expect(Object.keys(ledger)[0]).toMatch(/^[0-9a-f]{64}$/);

    // The next review pass re-injects the relative reference.
    seed();
    const second: string[][] = [];
    const result = await runReviewFinalize({
      ...baseOpts(second),
      exec: attachExec(second, { version: "2.101.0" }),
    });
    expect(edits(second)).toHaveLength(1);
    expect(edits(second)[0]).not.toContain("--attach");
    expect(result.screenshots_uploaded).toBe(0);
    expect(fs.readFileSync(bodyPath(), "utf8")).toContain(
      `![pricing phone](${HOSTED})`,
    );
  });

  it("attach: an old CLI records screenshots_gh_too_old and still writes the body, without image refs", async () => {
    seed();
    const calls: string[][] = [];
    const result = await runReviewFinalize({
      ...baseOpts(calls),
      exec: attachExec(calls, { version: "2.93.0" }),
    });
    expect(result.body_updated).toBe(true);
    expect(result.screenshots_uploaded).toBe(0);
    expect(result.skips.map((s) => s.step)).toContain("screenshots_gh_too_old");
    const [edit] = edits(calls);
    expect(edit).not.toContain("--attach");
    const pushed = fs.readFileSync(
      edit[edit.indexOf("--body-file") + 1],
      "utf8",
    );
    expect(pushed).not.toContain(REF);
    expect(pushed).toContain(LOCAL_LINK);
    expect(fs.readFileSync(bodyPath(), "utf8")).toContain(REF);
  });

  it("attach: a body over 60000 chars records screenshots_body_too_large, strips image refs, keeps local links", async () => {
    seed(`## Test Steps\n\n${REF}\n\n${LOCAL_LINK}\n\n${"x".repeat(60001)}\n`);
    const calls: string[][] = [];
    const result = await runReviewFinalize({
      ...baseOpts(calls),
      exec: attachExec(calls, { version: "2.101.0" }),
    });
    expect(result.skips.map((s) => s.step)).toContain(
      "screenshots_body_too_large",
    );
    const [edit] = edits(calls);
    expect(edit).not.toContain("--attach");
    const pushed = fs.readFileSync(
      edit[edit.indexOf("--body-file") + 1],
      "utf8",
    );
    expect(pushed).not.toContain(REF);
    expect(pushed).toContain(LOCAL_LINK);
    expect(result.body_updated).toBe(true);
  });

  it("attach: an upload failure retries the body write once without attachments and leaves the ledger empty", async () => {
    seed();
    const calls: string[][] = [];
    const result = await runReviewFinalize({
      ...baseOpts(calls),
      exec: attachExec(calls, { version: "2.101.0", attachFails: true }),
    });
    const all = edits(calls);
    expect(all).toHaveLength(2);
    expect(all[0]).toContain("--attach");
    expect(all[1]).not.toContain("--attach");
    expect(result.body_updated).toBe(true);
    expect(result.screenshots_uploaded).toBe(0);
    expect(result.skips.map((s) => s.step)).toContain(
      "screenshots_upload_failed",
    );
    expect(
      fs.existsSync(path.join(worktree, ".flow-tmp/ui-evidence/uploaded.json")),
    ).toBe(false);
  });

  it("attach: a body with no local image reference never probes gh --version", async () => {
    const calls: string[][] = [];
    await runReviewFinalize(baseOpts(calls));
    expect(calls.some((c) => c[1] === "--version")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("requires --pr, --worktree, --body-file, --status", () => {
    expect(parseArgs([])).toEqual({ error: "--pr is required" });
    expect(parseArgs(["--pr", "1"])).toEqual({
      error: "--worktree is required",
    });
    expect(parseArgs(["--pr", "1", "--worktree", "/tmp/x"])).toEqual({
      error: "--body-file is required",
    });
    expect(
      parseArgs([
        "--pr",
        "1",
        "--worktree",
        "/tmp/x",
        "--body-file",
        "/tmp/x/b.md",
      ]),
    ).toEqual({ error: "--status is required" });
  });

  it("rejects an invalid --status value", () => {
    expect(
      parseArgs([
        "--pr",
        "1",
        "--worktree",
        "/tmp/x",
        "--body-file",
        "/tmp/x/b.md",
        "--status",
        "bogus",
      ]),
    ).toEqual({ error: "invalid --status value: bogus" });
  });

  it("accepts repeatable --lens-model flags", () => {
    const parsed = parseArgs([
      "--pr",
      "1",
      "--worktree",
      "/tmp/x",
      "--body-file",
      "/tmp/x/b.md",
      "--status",
      "clean",
      "--lens-model",
      "security=alias-a",
      "--lens-model",
      "correctness=alias-b",
    ]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.lensModels).toEqual([
        "security=alias-a",
        "correctness=alias-b",
      ]);
    }
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("accepts repeatable --lens-tokens and a single --widened", () => {
    const parsed = parseArgs([
      "--pr",
      "1",
      "--worktree",
      "/tmp/x",
      "--body-file",
      "/tmp/x/b.md",
      "--status",
      "clean",
      "--lens-tokens",
      "security=12345",
      "--lens-tokens",
      "correctness=6789",
      "--widened",
      "consolidator asked for full scope",
    ]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.lensTokens).toEqual(["security=12345", "correctness=6789"]);
      expect(parsed.widened).toBe("consolidator asked for full scope");
    }
  });
});

describe("run()", () => {
  const stubResult: ReviewFinalize = {
    body_updated: true,
    screenshots_uploaded: 0,
    result_artifact: "/tmp/x/.flow-tmp/pr-review-result.json",
    result_valid: true,
    telemetry_recorded: true,
    untracked_added: 0,
    last_sha: "deadbeef",
    tier_copied: false,
    lens_models_forwarded: 0,
    lens_tokens_forwarded: 0,
    skips: [],
  };

  it("bad arguments exit 2 without invoking reviewFinalize", async () => {
    let called = false;
    const code = await run(["--pr", "abc"], async () => {
      called = true;
      return stubResult;
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it("prints the envelope on stdout and exits 0", async () => {
    const logSpy = console.log;
    const lines: string[] = [];
    console.log = (s: string) => lines.push(s);
    try {
      const code = await run(
        [
          "--pr",
          "7",
          "--worktree",
          "/tmp/x",
          "--body-file",
          "/tmp/x/.flow-tmp/body.md",
          "--status",
          "clean",
        ],
        async () => stubResult,
      );
      expect(code).toBe(0);
      expect(lines.join("")).toBe(JSON.stringify(stubResult));
    } finally {
      console.log = logSpy;
    }
  });
});
