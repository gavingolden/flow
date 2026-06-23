/**
 * Tests for `flow epic`. The `create` subcommand is side-effect-free in this
 * skeleton (it resolves + prints a slug/dir but writes nothing), so these
 * specs capture console.log / console.error via spies and assert on the
 * captured output — no tmux mock and no real-fs writes are needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEpicCli } from "./epic";

let logs!: string[];
let errors!: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runEpicCli — verb-level help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`['${flag}'] returns 0, emits help, no minted-slug notice`, () => {
      const code = runEpicCli([flag]);
      expect(code).toBe(0);
      expect(logs.length).toBeGreaterThan(0);
      // The verb help must not have resolved a slug as a side effect. The help
      // body legitimately mentions `.flow/epics/<slug>` in prose, so the
      // discriminator is the create side-effect's "resolved" notice line.
      expect(logs.join("\n")).not.toMatch(/resolved epic directory/i);
    });
  }
});

describe("runEpicCli create", () => {
  it("['create','--help'] returns 0, emits the create-specific help, no side effect", () => {
    const code = runEpicCli(["create", "--help"]);
    expect(code).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
    const joined = logs.join("\n");
    // Must reach runCreate's create-specific help, NOT the verb-level help.
    // The create help names `flow epic create`; the verb help (printVerbHelp)
    // additionally lists the run/status/ls subcommands, so the absence of
    // `run <id>` discriminates create-help from verb-help.
    expect(joined).toContain("flow epic create");
    expect(joined).not.toContain("run <id>");
    // create --help must NOT mint/resolve a slug. The create-help body mentions
    // `.flow/epics/<slug>` in prose, so assert the side-effect "resolved"
    // notice line is absent rather than the documentational path substring.
    expect(joined).not.toMatch(/resolved epic directory/i);
  });

  it("['create','add a watchlist feature'] resolves the slug + dir + F4/F5 notice", () => {
    const code = runEpicCli(["create", "add a watchlist feature"]);
    expect(code).toBe(0);
    // The resolved dir is the load-bearing first line F5 consumes — pin it
    // exactly (own line, no prefix) so a reorder/prefix regression goes red.
    expect(logs[0]).toBe(".flow/epics/add-watchlist-feature");
    const joined = logs.join("\n");
    expect(joined).toContain("add-watchlist-feature");
    expect(joined).toContain(".flow/epics/add-watchlist-feature");
    expect(joined).toMatch(/F4\/F5/);
  });

  it("stop-word-only prompts mint distinct task-<hash> ids; same prompt is deterministic", () => {
    const slugFromPath = (entries: string[]): string => {
      const line = entries.find((l) => l.includes(".flow/epics/"));
      expect(line).toBeDefined();
      const match = (line as string).match(/\.flow\/epics\/(\S+)/);
      expect(match).not.toBeNull();
      return (match as RegExpMatchArray)[1];
    };

    runEpicCli(["create", "the and or"]);
    const slugA = slugFromPath(logs);

    logs = [];
    runEpicCli(["create", "a to of"]);
    const slugB = slugFromPath(logs);

    logs = [];
    runEpicCli(["create", "the and or"]);
    const slugARepeat = slugFromPath(logs);

    expect(slugA).toMatch(/^task-/);
    expect(slugB).toMatch(/^task-/);
    expect(slugA).not.toBe(slugB);
    expect(slugARepeat).toBe(slugA);
  });
});

describe("runEpicCli deferred subcommands", () => {
  it("['run','some-id'] returns 2 and names the orchestrator run phase on stderr", () => {
    const code = runEpicCli(["run", "some-id"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/run phase/);
  });

  it("['status','some-id'] returns 2 with a deferred message that does NOT name the run phase", () => {
    const code = runEpicCli(["status", "some-id"]);
    expect(code).toBe(2);
    const joined = errors.join("\n");
    expect(joined).toContain("deferred");
    expect(joined).not.toMatch(/run phase/);
  });

  it("['ls'] returns 2 with a deferred message that does NOT name the run phase", () => {
    const code = runEpicCli(["ls"]);
    expect(code).toBe(2);
    const joined = errors.join("\n");
    expect(joined).toContain("deferred");
    expect(joined).not.toMatch(/run phase/);
  });
});

describe("runEpicCli usage errors", () => {
  it("[] (no subcommand) returns 2 with a usage message on stderr", () => {
    const code = runEpicCli([]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage/i);
  });

  it("['frobnicate'] (unknown) returns 2 with an unknown-subcommand message", () => {
    const code = runEpicCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown epic subcommand/);
  });

  it("['create'] (empty prompt) returns 2 with a usage message on stderr", () => {
    const code = runEpicCli(["create"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage|required/i);
  });
});
