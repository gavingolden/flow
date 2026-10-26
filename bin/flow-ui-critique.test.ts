import { describe, expect, it } from "vitest";

import {
  CRITIC_MAX_BUDGET_USD,
  parseArgs,
  run,
  type Deps,
  type HeadlessEnvelope,
} from "./flow-ui-critique";
import { readLedger } from "./lib/ui-critique-ledger";

const W = "/wt";
const HOME = "/home/u";
const LEDGER = `${HOME}/.flow/logs/ui-critique.jsonl`;
const BODY = "## Test Steps\n\n- [ ] SUBJECTIVE: the page feels calm\n";
const SHOT = `${W}/.flow-tmp/ui-evidence/pricing-phone.png`;

type Harness = {
  files: Map<string, string>;
  out: string[];
  err: string[];
  spawned: { argv: string[]; cwd: string }[];
  deps: Deps;
};

function harness(
  seed: Record<string, unknown> = {},
  over: Partial<Deps> = {},
  headless: (argv: string[]) => HeadlessEnvelope = () => ({
    ran: false,
    skipReason: "claude-missing",
  }),
): Harness {
  const files = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  const h: Harness = {
    files,
    out: [],
    err: [],
    spawned: [],
    deps: undefined as unknown as Deps,
  };
  h.deps = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    copyFile: (a, b) => {
      const c = files.get(a);
      if (c === undefined) throw new Error(`ENOENT ${a}`);
      files.set(b, c);
    },
    fileExists: (p) => files.has(p),
    mkdirp: () => {},
    gitHead: () => "head1",
    resolveSkillPath: (skill, ref) => `/skills/${skill}/${ref}`,
    home: HOME,
    now: () => "2026-10-25T00:00:00.000Z",
    repo: () => "flow",
    slug: () => "slug",
    spawnHeadless: (argv, opts) => {
      h.spawned.push({ argv, cwd: opts.cwd });
      return headless(argv);
    },
    mkdtemp: () => "/scratch",
    removeDir: () => {},
    writeOut: (l) => void h.out.push(l),
    writeErr: (l) => void h.err.push(l),
    ...over,
  };
  return h;
}

const result = (h: Harness) => JSON.parse(h.out[h.out.length - 1]);
const logOf = (h: Harness) =>
  JSON.parse(h.files.get(`${W}/.flow-tmp/ui-critique/log.json`) ?? "null");
const ledgerOf = (h: Harness) => readLedger(h.files.get(LEDGER) ?? null);

describe("parseArgs", () => {
  it.each([
    [[], "unknown subcommand"],
    [["bogus"], "unknown subcommand: bogus"],
    [["gate", "--worktree", W], "--body-file is required"],
    [["gate", "--bogus", "x"], "unknown flag"],
    [["gate", "--body-file"], "requires a value"],
    [["persistent", "--worktree", W], "exactly one of"],
    [
      ["persistent", "--worktree", W, "--check", "--record", "x"],
      "exactly one of",
    ],
  ])("rejects %j", (argv, msg) => {
    const p = parseArgs(argv);
    expect("error" in p && p.error).toContain(msg);
  });

  it("run exits 2 with usage on bad args and 0 otherwise", () => {
    const h = harness();
    expect(run(["gate"], h.deps)).toBe(2);
    expect(h.err[0]).toContain("usage: flow-ui-critique");
    expect(h.out).toEqual([]);
  });

  it("--help prints the usage and exits 0", () => {
    const h = harness();
    expect(run(["--help"], h.deps)).toBe(0);
    expect(h.out[0]).toContain("usage: flow-ui-critique");
  });

  it("run converts a thrown runtime error into a ran:false skip with exit 0", () => {
    const h = harness(
      { [`${W}/.flow-tmp/ui-driver-result.json`]: "{}" },
      {
        gitHead: () => {
          throw new Error("boom");
        },
      },
    );
    expect(
      run(["round-begin", "--worktree", W, "--kind", "smell"], h.deps),
    ).toBe(0);
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "runtime-error",
      detail: "boom",
    });
  });
});

describe("gate", () => {
  const args = ["gate", "--body-file", "/b.md", "--worktree", W];

  it("is the pre-drive eligibility call without --driver-result", () => {
    const h = harness({ "/b.md": BODY });
    run(args, h.deps);
    expect(result(h)).toMatchObject({ run: true, mode: "fix", reason: "run" });
  });

  it("honours a strict-false ui.critique", () => {
    const h = harness({
      "/b.md": BODY,
      [`${HOME}/.flow/config.json`]: { ui: { critique: false } },
    });
    run(args, h.deps);
    expect(result(h).reason).toBe("disabled-by-config");
  });

  it("post-drive needs a passing drive with section shots", () => {
    const withDriver = (d: unknown) => {
      const h = harness({ "/b.md": BODY, "/d.json": d });
      run([...args, "--driver-result", "/d.json"], h.deps);
      return result(h);
    };
    expect(withDriver({ ran: true, ok: true, section_shots: [{}] }).run).toBe(
      true,
    );
    expect(withDriver({ ran: true, ok: true }).reason).toBe("no-section-shots");
    const skipped = withDriver({
      ran: false,
      ok: false,
      skipped_reason: "mcp-not-available",
    });
    expect(skipped.detail).toBe(
      "browser checks did not run (mcp-not-available)",
    );
  });

  it("goes list-only after three reverted rounds in the ledger", () => {
    const line = (outcome: string) =>
      JSON.stringify({ at: "x", repo: "r", slug: "s", outcome, costUsd: 0 });
    const h = harness({
      "/b.md": BODY,
      [LEDGER]: ["reverted", "reverted", "reverted"].map(line).join("\n"),
    });
    run(args, h.deps);
    expect(result(h)).toMatchObject({ run: true, mode: "list-only" });
  });

  it("an unreadable body is a named skip", () => {
    const h = harness();
    run(args, h.deps);
    expect(result(h)).toEqual({ ran: false, skipReason: "body-unreadable" });
  });
});

describe("rounds", () => {
  const tmp = `${W}/.flow-tmp`;
  const seed = () => ({
    [`${tmp}/ui-driver-result.json`]: { ran: true, ok: true, headSha: "old" },
    [`${tmp}/ui-captures.json`]: { routes: [] },
  });

  it("round-begin snapshots the artifacts that exist and records the round open before any fix", () => {
    const h = harness(seed());
    run(["round-begin", "--worktree", W, "--kind", "critique"], h.deps);
    expect(result(h)).toEqual({ preSha: "head1" });
    expect(
      h.files.has(`${tmp}/ui-critique/pre-round/ui-driver-result.json`),
    ).toBe(true);
    expect(h.files.has(`${tmp}/ui-critique/pre-round/ui-captures.json`)).toBe(
      true,
    );
    expect(h.files.has(`${tmp}/ui-critique/pre-round/ui-findings.json`)).toBe(
      false,
    );
    expect(logOf(h).round).toEqual({
      kind: "critique",
      preSha: "head1",
      open: true,
    });
  });

  it("round-begin rejects a bad kind and a missing HEAD as named skips", () => {
    expect(
      run(["round-begin", "--worktree", W, "--kind", "x"], harness().deps),
    ).toBe(0);
    const h = harness({}, { gitHead: () => null });
    run(["round-begin", "--worktree", W, "--kind", "smell"], h.deps);
    expect(result(h).skipReason).toBe("git-head-unavailable");
  });

  it("round-end revert restores the pre-round artifacts, re-stamps headSha and logs a reverted critique round", () => {
    const h = harness(seed());
    run(["round-begin", "--worktree", W, "--kind", "critique"], h.deps);
    h.files.set(
      `${tmp}/ui-driver-result.json`,
      JSON.stringify({ ran: true, ok: false, headSha: "mid" }),
    );
    h.deps.gitHead = () => "head2";
    run(
      [
        "round-end",
        "--worktree",
        W,
        "--decision",
        "revert",
        "--reason",
        "regressed",
        "--cost",
        "1.5",
      ],
      h.deps,
    );
    const restored = JSON.parse(h.files.get(`${tmp}/ui-driver-result.json`)!);
    expect(restored).toMatchObject({ ok: true, headSha: "head2" });
    expect(logOf(h)).toMatchObject({
      outcome: "reverted",
      costUsd: 1.5,
      round: { open: false, decision: "revert", reason: "regressed" },
    });
    expect(ledgerOf(h)).toMatchObject([
      { outcome: "reverted", repo: "flow", slug: "slug", costUsd: 1.5 },
    ]);
  });

  it("round-end keep stores the residual findings and leaves the artifacts alone", () => {
    const h = harness({
      ...seed(),
      "/residual.json": { findings: [{ id: "f", severity: "major" }] },
    });
    run(["round-begin", "--worktree", W, "--kind", "critique"], h.deps);
    h.files.set(`${tmp}/ui-captures.json`, "NEW");
    run(
      [
        "round-end",
        "--worktree",
        W,
        "--decision",
        "keep",
        "--reason",
        "ok",
        "--residual-file",
        "/residual.json",
      ],
      h.deps,
    );
    expect(h.files.get(`${tmp}/ui-captures.json`)).toBe("NEW");
    expect(logOf(h).residual).toHaveLength(1);
    expect(ledgerOf(h)[0].outcome).toBe("kept");
  });

  it("a smell round writes no ledger line, and ending with no open round is a named skip", () => {
    const h = harness(seed());
    run(["round-begin", "--worktree", W, "--kind", "smell"], h.deps);
    run(
      ["round-end", "--worktree", W, "--decision", "keep", "--reason", "ok"],
      h.deps,
    );
    expect(ledgerOf(h)).toEqual([]);
    run(
      ["round-end", "--worktree", W, "--decision", "keep", "--reason", "ok"],
      h.deps,
    );
    expect(result(h).skipReason).toBe("no-open-round");
  });
});

describe("record", () => {
  it("clean and list-only append a ledger line; list-only sets the mode", () => {
    const h = harness();
    run(
      [
        "record",
        "--worktree",
        W,
        "--outcome",
        "list-only",
        "--reason",
        "demoted",
        "--omitted",
        "2",
        "--cost",
        "0.4",
        "--complete",
      ],
      h.deps,
    );
    expect(logOf(h)).toMatchObject({
      outcome: "list-only",
      mode: "list-only",
      omittedSections: 2,
      costUsd: 0.4,
      completed: true,
    });
    run(
      ["record", "--worktree", W, "--outcome", "clean", "--reason", "none"],
      h.deps,
    );
    expect(ledgerOf(h).map((l) => l.outcome)).toEqual(["list-only", "clean"]);
  });

  it("skipped sets skip and writes no ledger line", () => {
    const h = harness();
    run(
      [
        "record",
        "--worktree",
        W,
        "--outcome",
        "skipped",
        "--reason",
        "browser checks did not run",
      ],
      h.deps,
    );
    expect(logOf(h).skip).toBe("browser checks did not run");
    expect(ledgerOf(h)).toEqual([]);
  });

  it("rejects an unknown outcome as a named skip", () => {
    const h = harness();
    run(
      ["record", "--worktree", W, "--outcome", "weird", "--reason", "x"],
      h.deps,
    );
    expect(result(h).skipReason).toBe("bad-outcome");
  });
});

describe("persistent", () => {
  const driver = (heuristicIssues: string[], consoleErrors: string[] = []) => ({
    ran: true,
    ok: false,
    fix_context: [
      {
        route: "/",
        consoleErrors,
        failedRequests: [],
        missingSelectors: [],
        heuristicIssues,
      },
    ],
  });

  it("records each attempt and flags defects present in all three with nothing else failing", () => {
    const h = harness();
    const issue = "[xs] anchor: #x lands under chrome";
    for (let i = 0; i < 3; i++) {
      h.files.set(`/d${i}.json`, JSON.stringify(driver([issue])));
      run(["persistent", "--worktree", W, "--record", `/d${i}.json`], h.deps);
    }
    run(["persistent", "--worktree", W, "--check"], h.deps);
    expect(result(h)).toEqual({ allPersistent: true, persistent: [issue] });
    expect(logOf(h).persistent).toEqual([issue]);
  });

  it("another failure class in the last attempt blocks it", () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.files.set(
        `/d${i}.json`,
        JSON.stringify(
          driver(["[xs] leak: token"], i === 2 ? ["TypeError"] : []),
        ),
      );
      run(["persistent", "--worktree", W, "--record", `/d${i}.json`], h.deps);
    }
    run(["persistent", "--worktree", W, "--check"], h.deps);
    expect(result(h).allPersistent).toBe(false);
    expect(logOf(h)).toBeNull();
  });

  it("does not record an attempt whose drive did not run", () => {
    const h = harness({ "/d.json": { ran: false, ok: false } });
    run(["persistent", "--worktree", W, "--record", "/d.json"], h.deps);
    expect(result(h)).toEqual({ recorded: false });
  });
});

describe("render", () => {
  const critDir = `${W}/.flow-tmp/ui-critique`;
  const shot = {
    route: "/",
    section: "Pricing",
    viewport: "phone",
    part: "whole",
    path: SHOT,
  };
  const finding = {
    id: "f",
    severity: "defect",
    route: "/",
    section: "Pricing",
    viewport: "phone",
    shot: SHOT,
    observation: "overlap",
    rule: "r",
    fix: "f",
  };

  function seeded(log: unknown) {
    return harness({
      "/b.md": BODY,
      [`${critDir}/log.json`]: log,
      [`${critDir}/round-0-driver.json`]: { section_shots: [shot] },
      [`${critDir}/after-driver.json`]: { section_shots: [shot] },
    });
  }

  it("upserts the section and the single DECISION item, writes ui-review.md, and reports counts", () => {
    const h = seeded({
      outcome: "kept",
      residual: [finding],
      persistent: ["[xs] leak: x"],
      round: { kind: "critique", preSha: "a", open: false, reason: "better" },
    });
    run(["render", "--worktree", W, "--body-file", "/b.md"], h.deps);
    expect(result(h)).toEqual({
      residualDefects: 1,
      persistentDefects: 1,
      decisionAdded: true,
    });
    const body = h.files.get("/b.md")!;
    expect(body).toContain("## UI review");
    expect(body).toMatch(
      /- \[ \] DECISION: accept this UI with 2 unresolved defect\(s\)/,
    );
    expect(h.files.get(`${W}/.flow-tmp/ui-review.md`)).toContain(
      "Critique round kept: better.",
    );
  });

  it("--push-copy strips local image refs and notes the deferred upload", () => {
    const h = seeded({ outcome: "clean" });
    run(
      [
        "render",
        "--worktree",
        W,
        "--body-file",
        "/b.md",
        "--push-copy",
        "/push.md",
      ],
      h.deps,
    );
    const push = h.files.get("/push.md")!;
    expect(push).not.toContain("](.flow-tmp/");
    expect(push).toContain(
      "Screenshots for this section attach when the review runs.",
    );
    expect(h.files.get("/b.md")).toContain("](.flow-tmp/ui-evidence/");
  });

  it("--skip writes the stub and no decision, and a clean re-render removes an old decision", () => {
    const h = seeded({ outcome: "kept", residual: [finding] });
    run(["render", "--worktree", W, "--body-file", "/b.md"], h.deps);
    expect(h.files.get("/b.md")).toContain("DECISION:");
    run(
      [
        "render",
        "--worktree",
        W,
        "--body-file",
        "/b.md",
        "--skip",
        "mcp-not-available",
      ],
      h.deps,
    );
    const body = h.files.get("/b.md")!;
    expect(body).toContain("Not run: mcp-not-available");
    expect(body).not.toContain("DECISION:");
    expect(result(h)).toMatchObject({ decisionAdded: false });
  });
});

describe("accept", () => {
  const finding = (severity: string) => ({
    id: "f",
    severity,
    route: "/",
    section: "A",
    viewport: "phone",
    shot: SHOT,
    observation: "o",
    rule: "r",
    fix: "f",
  });
  const seed = (regressed: boolean) => ({
    "/c.json": { decision: "keep", regressed },
    "/t.json": { findings: [finding("defect")] },
    "/a.json": { findings: [finding("minor")] },
  });

  it("keeps when the compare did not regress and the targeted location improved", () => {
    const h = harness(seed(false));
    run(
      [
        "accept",
        "--compare",
        "/c.json",
        "--targeted",
        "/t.json",
        "--after",
        "/a.json",
      ],
      h.deps,
    );
    expect(result(h).decision).toBe("keep");
  });

  it("reverts on a regression or when the post-round critique is missing", () => {
    const h = harness(seed(true));
    run(
      [
        "accept",
        "--compare",
        "/c.json",
        "--targeted",
        "/t.json",
        "--after",
        "/a.json",
      ],
      h.deps,
    );
    expect(result(h).decision).toBe("revert");
    const h2 = harness(seed(false));
    run(["accept", "--compare", "/c.json", "--targeted", "/t.json"], h2.deps);
    expect(result(h2)).toMatchObject({ decision: "revert" });
  });

  it("reverts when an input is unreadable", () => {
    const h = harness({});
    run(
      [
        "accept",
        "--compare",
        "/c.json",
        "--targeted",
        "/t.json",
        "--after",
        "/a.json",
      ],
      h.deps,
    );
    expect(result(h).decision).toBe("revert");
  });
});

describe("critique", () => {
  const shot = {
    route: "/",
    section: "Pricing",
    viewport: "phone",
    part: "whole",
    path: SHOT,
  };
  const base = () => ({
    "/d.json": {
      ran: true,
      ok: true,
      section_shots: [shot],
      route_snapshots: [
        { route: "/", path: `${W}/.flow-tmp/ui-evidence/snap.txt` },
      ],
    },
    "/plan.md": "## Layout Intent\n\nDesign intent: calm\n",
    "/skills/flow-ui-ux/references/rendered-critique.md": "rubric",
    "/skills/flow-ui-ux/references/visual-design.md": "vd",
    "/skills/flow-ui-ux/references/layout.md": "layout",
    "/skills/flow-ui-ux/references/accessibility.md": "a11y",
  });
  const args = [
    "critique",
    "--driver-result",
    "/d.json",
    "--plan",
    "/plan.md",
    "--phase",
    "round-0",
    "--out",
    "/out/critique-0.json",
    "--worktree",
    W,
  ];
  const reply = (findings: unknown[]) => (): HeadlessEnvelope => ({
    ran: true,
    artifact: "/child.json",
    total_cost_usd: 0.9,
  });

  it("runs the capped read-only critic with cwd = worktree and writes validated findings", () => {
    const f = {
      id: "f1",
      severity: "major",
      route: "/",
      section: "Pricing",
      viewport: "phone",
      shot: SHOT,
      observation: "o",
      rule: "layout.md",
      fix: "x",
    };
    const h = harness(
      {
        ...base(),
        "/child.json": {
          result: `Sure.\n${JSON.stringify({ findings: [f, { ...f, id: "f2", shot: "/etc/other.png" }] })}`,
        },
      },
      {},
      reply([f]),
    );
    expect(run(args, h.deps)).toBe(0);
    expect(result(h)).toMatchObject({
      ran: true,
      findingsPath: "/out/critique-0.json",
      counts: { defect: 0, major: 1, minor: 0 },
      dropped: 1,
      omittedSections: 0,
      total_cost_usd: 0.9,
    });
    const { argv, cwd } = h.spawned[0];
    expect(cwd).toBe(W);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--model",
        "opus",
        "--effort",
        "high",
        "--allowed-tools",
        "Read",
        "--max-budget-usd",
        String(CRITIC_MAX_BUDGET_USD),
        "--task",
        "ui-critique-round-0",
      ]),
    );
    expect(
      JSON.parse(h.files.get("/out/critique-0.json")!).findings,
    ).toHaveLength(1);
  });

  it("copies the four rule docs under the worktree and lists the copies in the prompt", () => {
    const h = harness(
      { ...base(), "/child.json": { result: '{"findings":[]}' } },
      {},
      reply([]),
    );
    run(args, h.deps);
    const rules = `${W}/.flow-tmp/ui-critique/rules`;
    for (const name of [
      "rendered-critique.md",
      "visual-design.md",
      "layout.md",
      "accessibility.md",
    ]) {
      expect(h.files.get(`${rules}/${name}`)).toBeDefined();
    }
    expect(h.files.get("/scratch/ui-critique-prompt.md")).toContain(
      `${rules}/rendered-critique.md`,
    );
    expect(h.files.get("/scratch/ui-critique-prompt.md")).toContain(
      "Design intent: calm",
    );
  });

  it.each([
    [
      "a missing rule doc",
      { resolveSkillPath: () => null },
      "rule-doc-missing",
    ],
    [
      "a missing rule file",
      { fileExists: (p: string) => !p.endsWith("layout.md") },
      "rule-doc-missing",
    ],
  ])("%s is a named skip, never a guessed path", (_n, over, reason) => {
    const h = harness(base(), over as Partial<Deps>);
    run(args, h.deps);
    expect(result(h)).toEqual({ ran: false, skipReason: reason });
    expect(h.spawned).toEqual([]);
  });

  it("zero shots is no-section-shots without spawning", () => {
    const h = harness({ ...base(), "/d.json": { ran: true, ok: true } });
    run(args, h.deps);
    expect(result(h).skipReason).toBe("no-section-shots");
    expect(h.spawned).toEqual([]);
  });

  it("forwards a headless skip and flags an unparseable reply", () => {
    const skipped = harness(base(), {}, () => ({
      ran: false,
      skipReason: "budget-exceeded",
    }));
    run(args, skipped.deps);
    expect(result(skipped)).toEqual({
      ran: false,
      skipReason: "budget-exceeded",
    });
    const junk = harness(
      { ...base(), "/child.json": { result: "no json" } },
      {},
      reply([]),
    );
    run(args, junk.deps);
    expect(result(junk)).toMatchObject({
      ran: false,
      skipReason: "unparseable-result",
    });
  });

  it("rejects a bad phase as a named skip", () => {
    const h = harness(base());
    run(
      args.map((a) => (a === "round-0" ? "later" : a)),
      h.deps,
    );
    expect(result(h).skipReason).toBe("bad-phase");
  });
});
