import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideEcho, run } from "./flow-request-echo-hook";
import { requestEchoHeader } from "./lib/request-echo";
import { requestFilePath, writeState, type PipelineState } from "./lib/state";

const SCRIPT = fileURLToPath(
  new URL("./flow-request-echo-hook.ts", import.meta.url),
);

const REQUEST = 'Add a "csv" export.\n```js\nconsole.log(`hi`);\n```\nDone.';

function stateOf(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "csv-export",
    phase: "implementing",
    repo: "/work/flow",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-request-echo-hook-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function launch(opts: {
  args?: string[];
  env?: Record<string, string>;
  state?: PipelineState;
  request?: string;
}): { out: string; code: number } {
  if (opts.state !== undefined) writeState(opts.state, dir);
  if (opts.request !== undefined) {
    fs.writeFileSync(requestFilePath("csv-export", dir), opts.request);
  }
  let out = "";
  const code = run({
    argv: opts.args ?? [],
    env: opts.env ?? { FLOW_SLUG: "csv-export" },
    stateDir: dir,
    write: (s) => {
      out += s;
    },
  });
  return { out, code };
}

function parseOnly(out: string): { systemMessage: string } {
  const parsed = JSON.parse(out) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["systemMessage"]);
  return parsed as { systemMessage: string };
}

describe("flow-request-echo-hook run()", () => {
  it("prints one JSON object carrying the header, a blank line and the request byte-for-byte", () => {
    const state = stateOf({ forceResearch: true });
    const { out, code } = launch({ state, request: REQUEST });
    expect(code).toBe(0);
    expect(parseOnly(out).systemMessage).toBe(
      `${requestEchoHeader(state, "plain")}\n\n${REQUEST}`,
    );
  });

  it("echoes with --on-clear for a live pipeline", () => {
    const { out, code } = launch({
      args: ["--on-clear"],
      state: stateOf({ phase: "reviewing" }),
      request: REQUEST,
    });
    expect(code).toBe(0);
    expect(parseOnly(out).systemMessage).toContain(REQUEST);
  });

  it.each(["merged", "cancelled"] as const)(
    "prints nothing with --on-clear when the phase is %s",
    (phase) => {
      const { out, code } = launch({
        args: ["--on-clear"],
        state: stateOf({ phase }),
        request: REQUEST,
      });
      expect(code).toBe(0);
      expect(out).toBe("");
    },
  );

  it("still echoes a merged pipeline on the bare startup/compact entry", () => {
    const { out } = launch({
      state: stateOf({ phase: "merged" }),
      request: REQUEST,
    });
    expect(parseOnly(out).systemMessage).toContain(REQUEST);
  });

  it("prints nothing without FLOW_SLUG", () => {
    const { out, code } = launch({
      env: {},
      state: stateOf(),
      request: REQUEST,
    });
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  it("prints nothing for an invalid FLOW_SLUG", () => {
    const { out, code } = launch({
      env: { FLOW_SLUG: "../etc/passwd" },
      state: stateOf(),
      request: REQUEST,
    });
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  it("prints nothing for a valid slug with no state file", () => {
    const { out, code } = launch({ request: REQUEST });
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  it("prints nothing for an epic-run window", () => {
    const { out, code } = launch({
      state: stateOf({ kind: "epic-run" }),
      request: REQUEST,
    });
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  it("prints the one-line message when the request file is missing", () => {
    const { out, code } = launch({ state: stateOf() });
    expect(code).toBe(0);
    expect(parseOnly(out).systemMessage).toBe(
      "flow: could not read the request for csv-export",
    );
  });

  it("prints the one-line message when the request file is empty", () => {
    const { out, code } = launch({ state: stateOf(), request: "" });
    expect(code).toBe(0);
    expect(parseOnly(out).systemMessage).toBe(
      "flow: could not read the request for csv-export",
    );
  });

  it("caps an oversized request so the serialized output stays within 9,000 characters", () => {
    const { out } = launch({ state: stateOf(), request: "w".repeat(30000) });
    expect(out.length).toBeLessThanOrEqual(9000);
    expect(parseOnly(out).systemMessage).toContain("flow prompt csv-export");
  });

  it("returns 0 and prints nothing when reading state throws", () => {
    fs.writeFileSync(path.join(dir, "csv-export.json"), "{not json");
    const { out, code } = launch({});
    expect(code).toBe(0);
    expect(out).toBe("");
  });
});

describe("flow-request-echo-hook decideEcho()", () => {
  it("returns null when slug or state is null", () => {
    expect(
      decideEcho({
        onClear: false,
        slug: null,
        state: stateOf(),
        requestText: "x",
      }),
    ).toBeNull();
    expect(
      decideEcho({
        onClear: false,
        slug: "csv-export",
        state: null,
        requestText: "x",
      }),
    ).toBeNull();
  });
});

describe("flow-request-echo-hook executable", () => {
  it("is executable", () => {
    expect(() => fs.accessSync(SCRIPT, fs.constants.X_OK)).not.toThrow();
  });
});
