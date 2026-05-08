import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseArgs,
  parseOlderThan,
  matchesBranchFilter,
  shouldDelete,
  main,
  type Args,
  type Deployment,
} from "./prune-cf-deployments";

const PROJECT = "my-project";

function buildArgs(overrides: Partial<Args> = {}): Args {
  return {
    project: PROJECT,
    olderThan: new Date("2026-01-01T00:00:00Z"),
    branchGlobs: [],
    keepAliased: true,
    keepProductionLatest: true,
    max: 50,
    apply: false,
    ...overrides,
  };
}

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep-1",
    created_on: "2025-01-01T00:00:00Z",
    deployment_trigger: { metadata: { branch: "feat/x" } },
    aliases: null,
    environment: "preview",
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("returns Args with defaults for minimal valid input", () => {
    const result = parseArgs(["--project", "foo", "--older-than", "30d"]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.project).toBe("foo");
    expect(result.apply).toBe(false);
    expect(result.max).toBe(50);
    expect(result.keepAliased).toBe(true);
    expect(result.keepProductionLatest).toBe(true);
    expect(result.branchGlobs).toEqual([]);
  });

  it("errors when --project is missing", () => {
    const result = parseArgs(["--older-than", "30d"]);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("--project");
  });

  it("errors when --older-than is missing", () => {
    const result = parseArgs(["--project", "foo"]);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("--older-than");
  });

  it("collects repeated --branch flags including !-prefixed entries", () => {
    const result = parseArgs([
      "--project",
      "foo",
      "--older-than",
      "30d",
      "--branch",
      "feat/*",
      "--branch",
      "!main",
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.branchGlobs).toEqual(["feat/*", "!main"]);
  });

  it("--apply flips apply=true", () => {
    const result = parseArgs([
      "--project",
      "foo",
      "--older-than",
      "30d",
      "--apply",
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.apply).toBe(true);
  });

  it("--no-keep-aliased flips keepAliased=false", () => {
    const result = parseArgs([
      "--project",
      "foo",
      "--older-than",
      "30d",
      "--no-keep-aliased",
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.keepAliased).toBe(false);
  });

  it("--max 10 parses to 10", () => {
    const result = parseArgs([
      "--project",
      "foo",
      "--older-than",
      "30d",
      "--max",
      "10",
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.max).toBe(10);
  });

  it("invalid --max value returns error", () => {
    const result = parseArgs([
      "--project",
      "foo",
      "--older-than",
      "30d",
      "--max",
      "abc",
    ]);
    expect("error" in result).toBe(true);
  });
});

describe("parseOlderThan", () => {
  it("'30d' returns 30 days before now", () => {
    const now = new Date("2026-05-09T00:00:00Z");
    const result = parseOlderThan("30d", now);
    expect(result instanceof Date).toBe(true);
    if (!(result instanceof Date)) return;
    const expected = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("'7d' returns 7 days before now", () => {
    const now = new Date("2026-05-09T00:00:00Z");
    const result = parseOlderThan("7d", now);
    expect(result instanceof Date).toBe(true);
    if (!(result instanceof Date)) return;
    const expected = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("ISO date '2026-01-01' returns midnight UTC Date", () => {
    const result = parseOlderThan("2026-01-01");
    expect(result instanceof Date).toBe(true);
    if (!(result instanceof Date)) return;
    expect(result.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("ISO datetime returns parsed Date", () => {
    const result = parseOlderThan("2026-01-01T12:00:00Z");
    expect(result instanceof Date).toBe(true);
    if (!(result instanceof Date)) return;
    expect(result.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("garbage input returns error", () => {
    const result = parseOlderThan("garbage");
    expect(result instanceof Date).toBe(false);
    if (result instanceof Date) return;
    expect(result.error).toContain("invalid --older-than");
  });
});

describe("matchesBranchFilter", () => {
  it("empty globs returns true (no filter)", () => {
    expect(matchesBranchFilter("anything", [])).toBe(true);
  });

  it("['feat/*'] matches 'feat/foo'", () => {
    expect(matchesBranchFilter("feat/foo", ["feat/*"])).toBe(true);
  });

  it("['feat/*'] does not match 'main'", () => {
    expect(matchesBranchFilter("main", ["feat/*"])).toBe(false);
  });

  it("['!main'] matches 'feat/foo' (negative-only treats as all-except)", () => {
    expect(matchesBranchFilter("feat/foo", ["!main"])).toBe(true);
  });

  it("['!main'] does not match 'main'", () => {
    expect(matchesBranchFilter("main", ["!main"])).toBe(false);
  });

  it("['feat/*', '!feat/wip-*'] matches 'feat/foo'", () => {
    expect(
      matchesBranchFilter("feat/foo", ["feat/*", "!feat/wip-*"]),
    ).toBe(true);
  });

  it("['feat/*', '!feat/wip-*'] does not match 'feat/wip-x'", () => {
    expect(
      matchesBranchFilter("feat/wip-x", ["feat/*", "!feat/wip-*"]),
    ).toBe(false);
  });
});

describe("shouldDelete", () => {
  const now = new Date("2026-05-09T00:00:00Z");

  it("production-latest is skipped when keepProductionLatest=true", () => {
    const args = buildArgs({
      olderThan: new Date("2026-01-01T00:00:00Z"),
      keepProductionLatest: true,
    });
    const d = deployment({ id: "prod-1" });
    const verdict = shouldDelete(d, args, "prod-1", now);
    expect(verdict.delete).toBe(false);
    expect(verdict.reason).toBe("production-latest");
  });

  it("aliased deployment is skipped when keepAliased=true", () => {
    const args = buildArgs({
      olderThan: new Date("2026-01-01T00:00:00Z"),
      keepAliased: true,
    });
    const d = deployment({ aliases: ["main.example.com"] });
    const verdict = shouldDelete(d, args, null, now);
    expect(verdict.delete).toBe(false);
    expect(verdict.reason).toBe("aliased");
  });

  it("too-recent deployment is skipped", () => {
    const args = buildArgs({
      olderThan: new Date("2024-01-01T00:00:00Z"),
    });
    const d = deployment({ created_on: "2025-06-01T00:00:00Z" });
    const verdict = shouldDelete(d, args, null, now);
    expect(verdict.delete).toBe(false);
    expect(verdict.reason).toBe("too-recent");
  });

  it("branch-excluded when branch does not match globs", () => {
    const args = buildArgs({
      olderThan: new Date("2026-01-01T00:00:00Z"),
      branchGlobs: ["feat/*"],
    });
    const d = deployment({
      created_on: "2025-01-01T00:00:00Z",
      deployment_trigger: { metadata: { branch: "main" } },
    });
    const verdict = shouldDelete(d, args, null, now);
    expect(verdict.delete).toBe(false);
    expect(verdict.reason).toBe("branch-excluded");
  });

  it("eligible when no skip conditions trigger", () => {
    const args = buildArgs({
      olderThan: new Date("2026-01-01T00:00:00Z"),
      branchGlobs: ["feat/*"],
    });
    const d = deployment({
      created_on: "2025-01-01T00:00:00Z",
      deployment_trigger: { metadata: { branch: "feat/x" } },
    });
    const verdict = shouldDelete(d, args, null, now);
    expect(verdict.delete).toBe(true);
    expect(verdict.reason).toBe("eligible");
  });
});

describe("main() integration via mocked fetch", () => {
  // Use any-typed handles: vi.spyOn's MockInstance generic doesn't unify with
  // process.stdout.write's overloaded signature in strict mode. The tests only
  // read .mock.calls, so the precise type isn't load-bearing here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdout: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderr: any;
  let originalToken: string | undefined;
  let originalAcct: string | undefined;

  beforeEach(() => {
    originalToken = process.env.CLOUDFLARE_API_TOKEN;
    originalAcct = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-acct";
    stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    if (originalAcct === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAcct;
    vi.restoreAllMocks();
  });

  function mockFetch(
    deployments: Deployment[],
    productionId: string | null = null,
  ) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        if (url.endsWith(`/projects/${PROJECT}`)) {
          return new Response(
            JSON.stringify({
              result: productionId
                ? { canonical_deployment: { id: productionId } }
                : {},
            }),
            { status: 200 },
          );
        }
        if (url.includes("/deployments?page=1")) {
          return new Response(JSON.stringify({ result: deployments }), {
            status: 200,
          });
        }
        if (url.includes("/deployments?page=")) {
          return new Response(JSON.stringify({ result: [] }), {
            status: 200,
          });
        }
        if (
          /\/deployments\/[^?]+\?force=true$/.test(url) &&
          init?.method === "DELETE"
        ) {
          return new Response("{}", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
  }

  function stdoutText(): string {
    return stdout.mock.calls.flat().join("");
  }
  function stderrText(): string {
    return stderr.mock.calls.flat().join("");
  }

  it("age filter: only deployments older than cutoff appear in eligible list", async () => {
    const deployments: Deployment[] = [
      {
        id: "old-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/x" } },
        aliases: null,
      },
      {
        id: "fresh-1",
        created_on: "2026-05-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/y" } },
        aliases: null,
      },
    ];
    mockFetch(deployments);
    const code = await main([
      "--project",
      PROJECT,
      "--older-than",
      "30d",
    ]);
    expect(code).toBe(0);
    const out = stdoutText();
    expect(out).toContain("old-1");
    expect(out).not.toContain("fresh-1");
  });

  it("branch include glob: only matching deployments are eligible", async () => {
    const deployments: Deployment[] = [
      {
        id: "feat-x",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/x" } },
        aliases: null,
      },
      {
        id: "main-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "main" } },
        aliases: null,
      },
    ];
    mockFetch(deployments);
    await main([
      "--project",
      PROJECT,
      "--older-than",
      "30d",
      "--branch",
      "feat/*",
    ]);
    const out = stdoutText();
    expect(out).toContain("feat-x");
    expect(out).not.toContain("main-1");
  });

  it("branch exclude glob (!): excludes matching branches", async () => {
    const deployments: Deployment[] = [
      {
        id: "feat-x",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/x" } },
        aliases: null,
      },
      {
        id: "main-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "main" } },
        aliases: null,
      },
    ];
    mockFetch(deployments);
    await main([
      "--project",
      PROJECT,
      "--older-than",
      "30d",
      "--branch",
      "!main",
    ]);
    const out = stdoutText();
    expect(out).toContain("feat-x");
    expect(out).not.toContain("main-1");
  });

  it("aliased deployment is skipped (default --keep-aliased=true)", async () => {
    const deployments: Deployment[] = [
      {
        id: "aliased-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/x" } },
        aliases: ["custom.example.com"],
      },
      {
        id: "plain-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/y" } },
        aliases: null,
      },
    ];
    mockFetch(deployments);
    await main(["--project", PROJECT, "--older-than", "30d"]);
    const out = stdoutText();
    expect(out).not.toContain("aliased-1");
    expect(out).toContain("plain-1");
  });

  it("production-latest deployment is skipped", async () => {
    const deployments: Deployment[] = [
      {
        id: "prod-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "main" } },
        aliases: null,
      },
      {
        id: "preview-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/x" } },
        aliases: null,
      },
    ];
    mockFetch(deployments, "prod-1");
    await main(["--project", PROJECT, "--older-than", "30d"]);
    const out = stdoutText();
    expect(out).not.toContain("prod-1");
    expect(out).toContain("preview-1");
  });

  it("--max caps eligible list", async () => {
    const deployments: Deployment[] = Array.from({ length: 100 }, (_, i) => ({
      id: `dep-${i}`,
      created_on: "2024-01-01T00:00:00Z",
      deployment_trigger: { metadata: { branch: "feat/x" } },
      aliases: null,
    }));
    mockFetch(deployments);
    await main([
      "--project",
      PROJECT,
      "--older-than",
      "30d",
      "--max",
      "10",
    ]);
    const out = stdoutText();
    expect(out).toContain("Found 10 deployments to delete");
  });

  it("--dry-run prints plan but never calls DELETE", async () => {
    const deployments: Deployment[] = [
      {
        id: "old-1",
        created_on: "2024-01-01T00:00:00Z",
        deployment_trigger: { metadata: { branch: "feat/x" } },
        aliases: null,
      },
    ];
    const fetchSpy = mockFetch(deployments);
    await main(["--project", PROJECT, "--older-than", "30d"]);
    const deleteCalls = fetchSpy.mock.calls.filter(
      (c) =>
        (c[1] as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(0);
    expect(stdoutText()).toContain("Dry run");
  });

  it("errors with exit code 2 when CLOUDFLARE_API_TOKEN is missing", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const code = await main([
      "--project",
      PROJECT,
      "--older-than",
      "30d",
    ]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("CLOUDFLARE_API_TOKEN");
  });
});
