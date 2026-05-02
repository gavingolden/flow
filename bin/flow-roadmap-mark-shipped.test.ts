import { describe, expect, it, vi } from "vitest";
import {
  commitMessage,
  main,
  parseArgs,
  run,
  transformRoadmap,
  type GhResult,
  type GhRunner,
} from "./flow-roadmap-mark-shipped";

const ROADMAP_FIXTURE = `# Roadmap

Legend: ✅ shipped · 🚧 in review · ⬜ queued · ⏸ optional

| Item | Description | Status |
|---|---|---|
| **Item 13 — auto-merge authorization** | Carve out exemption | 🚧 in review (#54) |
| **Item 14 — supervisor↔skill contract** | Three contract issues | ⬜ queued |

### Item 13 — auto-merge authorization

Status: 🚧 in review (#54).

Body of Item 13 detail block.

### Item 14 — supervisor↔skill contract

Status: ⬜ queued.

Body of Item 14.
`;

function gh(responses: Map<string, GhResult>): {
  runner: GhRunner;
  calls: { args: string[]; stdin?: string }[];
} {
  const calls: { args: string[]; stdin?: string }[] = [];
  const runner: GhRunner = (args, stdin) => {
    calls.push({ args: [...args], stdin });
    const key = args.join(" ");
    const response = responses.get(key);
    if (!response) {
      throw new Error(
        `unmocked gh call: ${key}\n  registered keys: ${[...responses.keys()].join(" | ")}`,
      );
    }
    return response;
  };
  return { runner, calls };
}

function ghContentResponse(content: string, sha: string): GhResult {
  return {
    stdout: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      sha,
      encoding: "base64",
    }),
    stderr: "",
    exitCode: 0,
  };
}

const FIXTURE_REPO = "owner/flow";
const FIXTURE_PATH = "docs/roadmap.md";
const GET_KEY = `api /repos/${FIXTURE_REPO}/contents/${FIXTURE_PATH}?ref=main`;
const PUT_KEY = `api -X PUT /repos/${FIXTURE_REPO}/contents/${FIXTURE_PATH} --input -`;

describe("parseArgs", () => {
  it("requires --pr", () => {
    expect(parseArgs([])).toEqual({ error: "--pr is required" });
  });

  it("rejects a non-positive --pr", () => {
    expect(parseArgs(["--pr", "0"])).toEqual({
      error: "--pr must be a positive integer, got '0'",
    });
  });

  it("rejects a non-integer --pr", () => {
    expect(parseArgs(["--pr", "abc"])).toEqual({
      error: "--pr must be a positive integer, got 'abc'",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--bogus", "x"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("rejects a value-taking flag with no value", () => {
    expect(parseArgs(["--pr"])).toEqual({ error: "--pr requires a value" });
  });

  it("rejects a flag whose value is the next flag", () => {
    expect(parseArgs(["--pr", "--repo"])).toEqual({ error: "--pr requires a value" });
  });

  it("parses every flag with explicit values", () => {
    expect(
      parseArgs([
        "--pr", "54",
        "--repo", "owner/flow",
        "--path", "ROADMAP.md",
        "--ref", "develop",
        "--dry-run",
      ]),
    ).toEqual({
      pr: 54,
      repo: "owner/flow",
      path: "ROADMAP.md",
      ref: "develop",
      dryRun: true,
    });
  });

  it("defaults path/ref/dryRun when only --pr is given", () => {
    expect(parseArgs(["--pr", "54"])).toEqual({
      pr: 54,
      repo: undefined,
      path: "docs/roadmap.md",
      ref: "main",
      dryRun: false,
    });
  });
});

describe("transformRoadmap", () => {
  it("flips both the table row cell and the Status: line for the matching PR", () => {
    const result = transformRoadmap(ROADMAP_FIXTURE, 54);
    expect(result.rowMatches).toBe(1);
    expect(result.statusMatches).toBe(1);
    expect(result.itemNumber).toBe(13);
    expect(result.next).toContain("| ✅ shipped (#54) |");
    expect(result.next).toContain("Status: ✅ shipped (#54).");
    expect(result.next).not.toContain("🚧 in review (#54)");
  });

  it("is idempotent: running on already-shipped roadmap yields identical content", () => {
    const once = transformRoadmap(ROADMAP_FIXTURE, 54).next;
    const twice = transformRoadmap(once, 54).next;
    expect(twice).toBe(once);
  });

  it("returns zero matches when the PR number is not present", () => {
    const result = transformRoadmap(ROADMAP_FIXTURE, 999);
    expect(result.rowMatches).toBe(0);
    expect(result.statusMatches).toBe(0);
    expect(result.next).toBe(ROADMAP_FIXTURE);
  });

  it("counts multiple table rows containing the same PR ref as ambiguity", () => {
    const ambiguous = ROADMAP_FIXTURE.replace(
      "| **Item 14 — supervisor↔skill contract** | Three contract issues | ⬜ queued |",
      "| **Item 14 — supervisor↔skill contract** | sibling row | 🚧 in review (#54) |",
    );
    const result = transformRoadmap(ambiguous, 54);
    expect(result.rowMatches).toBe(2);
  });

  it("preserves rows for other items that do not reference the PR", () => {
    const result = transformRoadmap(ROADMAP_FIXTURE, 54).next;
    expect(result).toContain("| **Item 14 — supervisor↔skill contract** | Three contract issues | ⬜ queued |");
    expect(result).toContain("Status: ⬜ queued.");
  });

  it("extracts the Item number from the matched row for the commit message", () => {
    const result = transformRoadmap(ROADMAP_FIXTURE, 54);
    expect(result.itemNumber).toBe(13);
  });
});

describe("commitMessage", () => {
  it("includes the Item number when known", () => {
    expect(commitMessage(13, 54)).toBe("chore(roadmap): mark Item 13 shipped (#54)");
  });

  it("falls back to 'row' when the item number could not be parsed", () => {
    expect(commitMessage(null, 54)).toBe("chore(roadmap): mark row shipped (#54)");
  });
});

describe("run", () => {
  it("flips the row, PUTs new content, returns success with commit sha", async () => {
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(ROADMAP_FIXTURE, "sha-A")],
      [PUT_KEY, { stdout: JSON.stringify({ commit: { sha: "deadbeef00" } }), stderr: "", exitCode: 0 }],
    ]);
    const { runner, calls } = gh(responses);
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: true, changed: true, commitSha: "deadbeef00", itemNumber: 13 });
    expect(calls).toHaveLength(2);
    const putCall = calls[1]!;
    expect(putCall.stdin).toBeDefined();
    const body = JSON.parse(putCall.stdin!);
    expect(body.message).toBe("chore(roadmap): mark Item 13 shipped (#54)");
    expect(body.sha).toBe("sha-A");
    expect(body.branch).toBe("main");
    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    expect(decoded).toContain("| ✅ shipped (#54) |");
  });

  it("idempotent no-op: skips PUT when content is unchanged", async () => {
    const alreadyShipped = transformRoadmap(ROADMAP_FIXTURE, 54).next;
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(alreadyShipped, "sha-A")],
    ]);
    const { runner, calls } = gh(responses);
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toEqual({ ok: true, changed: false, itemNumber: 13 });
    expect(calls).toHaveLength(1); // GET only — no PUT
  });

  it("dry-run prints diff and skips PUT", async () => {
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(ROADMAP_FIXTURE, "sha-A")],
    ]);
    const { runner, calls } = gh(responses);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: true },
      runner,
    );
    expect(result).toMatchObject({ ok: true, changed: false, itemNumber: 13 });
    expect(calls).toHaveLength(1);
    const printed = logs.join("\n");
    expect(printed).toContain("- | **Item 13");
    expect(printed).toContain("+ | **Item 13");
    expect(printed).toContain("✅ shipped (#54)");
    logSpy.mockRestore();
  });

  it("returns code 2 when no row references the PR", async () => {
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(ROADMAP_FIXTURE, "sha-A")],
    ]);
    const { runner } = gh(responses);
    const result = await run(
      { pr: 999, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: false, code: 2 });
    if (!result.ok) expect(result.message).toMatch(/no row found for PR #999/);
  });

  it("returns code 2 on multiple matching table rows", async () => {
    const ambiguous = ROADMAP_FIXTURE.replace(
      "| **Item 14 — supervisor↔skill contract** | Three contract issues | ⬜ queued |",
      "| **Item 14 — supervisor↔skill contract** | sibling row | 🚧 in review (#54) |",
    );
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(ambiguous, "sha-A")],
    ]);
    const { runner } = gh(responses);
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: false, code: 2 });
    if (!result.ok) expect(result.message).toMatch(/multiple table rows/);
  });

  it("retries once on 409 conflict and succeeds", async () => {
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(ROADMAP_FIXTURE, "sha-A")],
    ]);
    let getCount = 0;
    let putCount = 0;
    const runner: GhRunner = (args, stdin) => {
      const key = args.join(" ");
      if (key === GET_KEY) {
        getCount++;
        const sha = getCount === 1 ? "sha-A" : "sha-B";
        return ghContentResponse(ROADMAP_FIXTURE, sha);
      }
      if (key === PUT_KEY) {
        putCount++;
        if (putCount === 1) {
          return {
            stdout: "",
            stderr: "HTTP 409: sha does not match",
            exitCode: 22,
          };
        }
        const body = JSON.parse(stdin ?? "{}");
        expect(body.sha).toBe("sha-B");
        return {
          stdout: JSON.stringify({ commit: { sha: "deadbeef" } }),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unmocked: ${key}`);
    };
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(getCount).toBe(2);
    expect(putCount).toBe(2);
  });

  it("409 conflict where the re-fetched roadmap is already shipped: returns ok no-op", async () => {
    // Race-with-self: another supervisor instance flipped the row between
    // our GET and our PUT. The 409 retry path re-fetches, finds the
    // transform yields no change, and short-circuits to ok/changed:false.
    const alreadyShipped = transformRoadmap(ROADMAP_FIXTURE, 54).next;
    let getCount = 0;
    const runner: GhRunner = (args) => {
      const key = args.join(" ");
      if (key === GET_KEY) {
        getCount++;
        // First GET: stale (in-review). Second GET (after 409): already shipped.
        return getCount === 1
          ? ghContentResponse(ROADMAP_FIXTURE, "sha-A")
          : ghContentResponse(alreadyShipped, "sha-B");
      }
      if (key === PUT_KEY) {
        return { stdout: "", stderr: "HTTP 409: sha does not match", exitCode: 22 };
      }
      throw new Error(`unmocked: ${key}`);
    };
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toEqual({ ok: true, changed: false, itemNumber: 13 });
    expect(getCount).toBe(2);
  });

  it("returns code 3 when the retry PUT also conflicts", async () => {
    const conflictResponse: GhResult = {
      stdout: "",
      stderr: "HTTP 409: sha does not match",
      exitCode: 22,
    };
    let getCount = 0;
    const runner: GhRunner = (args) => {
      const key = args.join(" ");
      if (key === GET_KEY) {
        getCount++;
        return ghContentResponse(ROADMAP_FIXTURE, `sha-${getCount}`);
      }
      if (key === PUT_KEY) return conflictResponse;
      throw new Error(`unmocked: ${key}`);
    };
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: false, code: 3 });
  });

  it("returns code 4 when the GET fails", async () => {
    const responses = new Map<string, GhResult>([
      [GET_KEY, { stdout: "", stderr: "auth required", exitCode: 4 }],
    ]);
    const { runner } = gh(responses);
    const result = await run(
      { pr: 54, repo: FIXTURE_REPO, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: false, code: 4 });
    if (!result.ok) expect(result.message).toMatch(/gh api GET failed/);
  });

  it("returns code 4 when repo cannot be auto-detected", async () => {
    const responses = new Map<string, GhResult>([
      ["repo view --json nameWithOwner -q .nameWithOwner", { stdout: "", stderr: "no remote", exitCode: 1 }],
    ]);
    const { runner } = gh(responses);
    const result = await run(
      { pr: 54, repo: undefined, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: false, code: 4 });
    if (!result.ok) expect(result.message).toMatch(/auto-detect repo/);
  });

  it("auto-detects repo when --repo not given", async () => {
    const responses = new Map<string, GhResult>([
      ["repo view --json nameWithOwner -q .nameWithOwner", { stdout: "owner/flow\n", stderr: "", exitCode: 0 }],
      [GET_KEY, ghContentResponse(ROADMAP_FIXTURE, "sha-A")],
      [PUT_KEY, { stdout: JSON.stringify({ commit: { sha: "ab" } }), stderr: "", exitCode: 0 }],
    ]);
    const { runner } = gh(responses);
    const result = await run(
      { pr: 54, repo: undefined, path: FIXTURE_PATH, ref: "main", dryRun: false },
      runner,
    );
    expect(result).toMatchObject({ ok: true, changed: true });
  });
});

describe("main", () => {
  it("returns 2 on bad args", async () => {
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    });
    const code = await main([]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--pr is required/);
    errSpy.mockRestore();
  });

  it("returns 0 on success", async () => {
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(ROADMAP_FIXTURE, "sha-A")],
      [PUT_KEY, { stdout: JSON.stringify({ commit: { sha: "deadbeef" } }), stderr: "", exitCode: 0 }],
    ]);
    const { runner } = gh(responses);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const code = await main(
      ["--pr", "54", "--repo", FIXTURE_REPO, "--path", FIXTURE_PATH],
      runner,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/marked PR #54 shipped/);
    logSpy.mockRestore();
  });

  it("returns 0 on idempotent no-op with a 'already shipped' log line", async () => {
    const alreadyShipped = transformRoadmap(ROADMAP_FIXTURE, 54).next;
    const responses = new Map<string, GhResult>([
      [GET_KEY, ghContentResponse(alreadyShipped, "sha-A")],
    ]);
    const { runner } = gh(responses);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const code = await main(
      ["--pr", "54", "--repo", FIXTURE_REPO, "--path", FIXTURE_PATH],
      runner,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/already shipped \(no-op\)/);
    logSpy.mockRestore();
  });
});
