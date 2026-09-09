import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateUiDriverResult } from "./ui-driver-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "ui-driver-schema.ts");
const OK_FIXTURE = path.resolve(
  __dirname,
  "__fixtures__/ui-driver-result.ok.json",
);
const BAD_FIXTURE = path.resolve(
  __dirname,
  "__fixtures__/ui-driver-result.bad.json",
);

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCHEMA_SCRIPT, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ui-driver-schema-test-"));
  const filePath = path.join(dir, "artifact.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_FULL: Record<string, unknown> = {
  ran: true,
  ok: true,
  captures_path: ".flow-tmp/ui-captures.json",
  ui_screenshots: [".flow-tmp/ui-screenshots/route-home.png"],
  fix_context: [
    {
      route: "/",
      consoleErrors: [],
      failedRequests: [],
      missingSelectors: [],
    },
  ],
  rejected_alternatives: ["Considered X; rejected because Y."],
  summary: "Drove / at desktop and mobile; no console errors.",
};

describe("validateUiDriverResult", () => {
  it("accepts a fully-populated valid artifact", () => {
    const result = validateUiDriverResult(VALID_FULL);
    expect(result.ok).toBe(true);
  });

  it("accepts a degraded/skipped artifact with skipped_reason", () => {
    const result = validateUiDriverResult({
      ran: false,
      ok: false,
      skipped_reason: "mcp-not-available",
      captures_path: "",
      ui_screenshots: [],
      fix_context: [],
      rejected_alternatives: [],
      summary: "chrome-devtools MCP not registered; skipped the drive.",
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    "mcp-not-available",
    "browser-profile-busy",
    "app-launch-failed",
    "login-failed",
    "screenshots-unwritable",
    "driver-no-artifact",
  ])("accepts skipped_reason member %s", (reason) => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      ran: false,
      ok: false,
      skipped_reason: reason,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown skipped_reason", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      skipped_reason: "not-a-real-reason",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    const result = validateUiDriverResult("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/must be a JSON object/);
    }
  });

  it("rejects a missing 'ran' boolean", () => {
    const { ran: _ran, ...rest } = VALID_FULL as Record<string, unknown>;
    const result = validateUiDriverResult(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("'ran'"))).toBe(true);
    }
  });

  it("rejects a missing 'ok' boolean", () => {
    const { ok: _ok, ...rest } = VALID_FULL as Record<string, unknown>;
    const result = validateUiDriverResult(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string captures_path", () => {
    const result = validateUiDriverResult({ ...VALID_FULL, captures_path: 7 });
    expect(result.ok).toBe(false);
  });

  it("rejects ui_screenshots with a non-string entry", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      ui_screenshots: [1, 2],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects rejected_alternatives with a non-string entry", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      rejected_alternatives: [{ considered_approach: "x" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty summary", () => {
    const result = validateUiDriverResult({ ...VALID_FULL, summary: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects fix_context that is not an array", () => {
    const result = validateUiDriverResult({ ...VALID_FULL, fix_context: {} });
    expect(result.ok).toBe(false);
  });

  it("rejects fix_context over the 10-entry cap", () => {
    const fixContext = Array.from({ length: 11 }, (_, i) => ({
      route: `/${i}`,
      consoleErrors: [],
      failedRequests: [],
      missingSelectors: [],
    }));
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: fixContext,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("10-entry cap"))).toBe(true);
    }
  });

  it("accepts fix_context at exactly the 10-entry cap", () => {
    const fixContext = Array.from({ length: 10 }, (_, i) => ({
      route: `/${i}`,
      consoleErrors: [],
      failedRequests: [],
      missingSelectors: [],
    }));
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: fixContext,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a fix_context route string over 300 chars", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: [
        {
          route: "/" + "a".repeat(300),
          consoleErrors: [],
          failedRequests: [],
          missingSelectors: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("300-char cap"))).toBe(true);
    }
  });

  it("accepts a fix_context route string at exactly 300 chars", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: [
        {
          route: "a".repeat(300),
          consoleErrors: [],
          failedRequests: [],
          missingSelectors: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a consoleErrors entry over 300 chars", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: [
        {
          route: "/",
          consoleErrors: ["e".repeat(301)],
          failedRequests: [],
          missingSelectors: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a failedRequests entry over 300 chars", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: [
        {
          route: "/",
          consoleErrors: [],
          failedRequests: ["f".repeat(301)],
          missingSelectors: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missingSelectors entry over 300 chars", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: [
        {
          route: "/",
          consoleErrors: [],
          failedRequests: [],
          missingSelectors: ["#".repeat(301)],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a fix_context entry missing an array field", () => {
    const result = validateUiDriverResult({
      ...VALID_FULL,
      fix_context: [{ route: "/", consoleErrors: [] }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("ui-driver-schema fixtures", () => {
  it("the ok fixture parses and validates", () => {
    const parsed = JSON.parse(fs.readFileSync(OK_FIXTURE, "utf8"));
    const result = validateUiDriverResult(parsed);
    expect(result.ok).toBe(true);
  });

  it("the bad fixture fails specifically on the fix_context cap", () => {
    const parsed = JSON.parse(fs.readFileSync(BAD_FIXTURE, "utf8"));
    const result = validateUiDriverResult(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("10-entry cap"))).toBe(true);
    }
  });
});

describe("ui-driver-schema CLI", () => {
  it("exits 0 on a valid file", () => {
    const { status, stdout } = runCli(["--validate", OK_FIXTURE]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });

  it("exits 1 on the bad (over-cap) fixture", () => {
    const { status, stderr } = runCli(["--validate", BAD_FIXTURE]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((e: string) => e.includes("10-entry cap"))).toBe(
      true,
    );
  });

  it("exits 1 on invalid JSON", () => {
    withTmpFile("{not json", (filePath) => {
      const { status, stderr } = runCli(["--validate", filePath]);
      expect(status).toBe(1);
      expect(JSON.parse(stderr).errors[0]).toMatch(/JSON parse failed/);
    });
  });

  it("exits 1 on a missing file", () => {
    const { status, stderr } = runCli([
      "--validate",
      "/nonexistent/path/ui-driver-result.json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stderr).errors[0]).toMatch(/read failed/);
  });

  it("exits 2 on missing --validate flag", () => {
    const { status } = runCli([]);
    expect(status).toBe(2);
  });

  it("exits 2 when --validate has no path argument", () => {
    const { status } = runCli(["--validate"]);
    expect(status).toBe(2);
  });
});
