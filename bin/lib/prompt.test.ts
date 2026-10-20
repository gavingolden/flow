import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPromptCli } from "./prompt";
import {
  writeState,
  writeRequestFile,
  requestFilePath,
  statePath,
} from "./state";
import { renderRequestEcho } from "./request-echo";
import type { PipelineState } from "./state";

describe(runPromptCli, () => {
  let stateDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-prompt-test-"));
    logged = [];
    errored = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logged.push(msg);
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      errored.push(msg);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function seed(
    slug: string,
    requestText: string,
    extra: Partial<PipelineState> = {},
  ) {
    const state: PipelineState = {
      slug,
      phase: "implementing",
      repo: "/work/flow",
      updatedAt: "2026-09-05T00:00:00.000Z",
      ...extra,
    };
    writeState(state, stateDir);
    writeRequestFile(slug, requestText, stateDir);
  }

  it("should print the request-echo block byte-for-byte and exit 0 when given an explicit slug with state and request file present", () => {
    const requestText = "add a csv export button";
    seed("csv-export", requestText);
    const code = runPromptCli(["csv-export"], { stateDir, env: {} });
    expect(code).toBe(0);
    const state: PipelineState = {
      slug: "csv-export",
      phase: "implementing",
      repo: "/work/flow",
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    expect(logged[0]).toBe(renderRequestEcho(state, requestText));
    expect(errored).toEqual([]);
  });

  it("should resolve the slug from FLOW_SLUG when no positional slug is given", () => {
    seed("csv-export", "add a csv export button");
    const code = runPromptCli([], {
      stateDir,
      env: { FLOW_SLUG: "csv-export" },
    });
    expect(code).toBe(0);
    expect(logged[0]).toContain("add a csv export button");
  });

  it("should exit non-zero with a usage message and empty stdout when neither a positional slug nor FLOW_SLUG is available", () => {
    const code = runPromptCli([], { stateDir, env: {} });
    expect(code).not.toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toMatch(/usage: flow prompt/);
  });

  it("should exit non-zero naming the state path with empty stdout when the state file is missing", () => {
    const code = runPromptCli(["ghost-slug"], { stateDir, env: {} });
    expect(code).not.toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toContain(path.join(stateDir, "ghost-slug.json"));
  });

  it("should exit non-zero naming the request path with empty stdout when the request file is missing", () => {
    const state: PipelineState = {
      slug: "no-request",
      phase: "implementing",
      repo: "/work/flow",
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    writeState(state, stateDir);
    const code = runPromptCli(["no-request"], { stateDir, env: {} });
    expect(code).not.toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toContain(requestFilePath("no-request", stateDir));
  });

  it("should exit non-zero with empty stdout and a named stderr reason when the request file is empty", () => {
    seed("empty-request", "");
    const code = runPromptCli(["empty-request"], { stateDir, env: {} });
    expect(code).not.toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toMatch(/request file is empty/);
  });

  it("should exit non-zero naming the state path with empty stdout when the state file is malformed JSON", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath("malformed-state", stateDir), "{not json", {
      mode: 0o600,
    });
    const code = runPromptCli(["malformed-state"], { stateDir, env: {} });
    expect(code).not.toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toContain("unreadable/invalid");
    expect(errored[0]).toContain(statePath("malformed-state", stateDir));
  });

  it("should exit non-zero with a named reason and empty stdout when the positional slug is invalid, without falling through to FLOW_SLUG", () => {
    const code = runPromptCli([""], {
      stateDir,
      env: { FLOW_SLUG: "csv-export" },
    });
    expect(code).not.toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toMatch(/invalid slug/);
    expect(errored[0]).not.toMatch(/FLOW_SLUG is not set/);
  });

  it('should print an epic pipeline\'s request when the state carries kind: "epic-design"', () => {
    seed("epic-slug", "design an epic for csv export", { kind: "epic-design" });
    const code = runPromptCli(["epic-slug"], { stateDir, env: {} });
    expect(code).toBe(0);
    expect(logged[0]).toContain("design an epic for csv export");
  });

  it("should exit 0 without touching state when --help is passed", () => {
    const code = runPromptCli(["--help"], { stateDir, env: {} });
    expect(code).toBe(0);
    expect(logged[0]).toMatch(/^flow prompt/);
  });
});
