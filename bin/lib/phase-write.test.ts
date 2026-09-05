import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePhaseState, type PhasePublisher } from "./phase-write";
import { readState, type PipelineState } from "./state";
import { setWindowPhase } from "./tmux";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-write-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "csv-export",
    phase: "reviewing",
    repo: "/tmp/repo",
    updatedAt: "2026-04-30T12:00:00Z",
    ...overrides,
  };
}

describe("writePhaseState", () => {
  it("the state file holds the new phase after writePhaseState", () => {
    writePhaseState(makeState({ phase: "gating" }), stateDir, () => {});
    expect(readState("csv-export", stateDir)?.phase).toBe("gating");
  });

  it("writes state BEFORE the publisher runs", () => {
    let phaseSeenByPublisher: string | null | undefined;
    const publish: PhasePublisher = () => {
      phaseSeenByPublisher = readState("csv-export", stateDir)?.phase;
    };
    writePhaseState(makeState({ phase: "gating" }), stateDir, publish);
    expect(phaseSeenByPublisher).toBe("gating");
  });

  it("the publisher receives exactly (state.slug, state.phase)", () => {
    const received: Array<[string, string]> = [];
    writePhaseState(
      makeState({ slug: "s1", phase: "merging" }),
      stateDir,
      (s, p) => received.push([s, p]),
    );
    expect(received).toEqual([["s1", "merging"]]);
  });

  it("swallows a throwing publisher and still leaves the state written", () => {
    expect(() =>
      writePhaseState(makeState({ phase: "gating" }), stateDir, () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    expect(readState("csv-export", stateDir)?.phase).toBe("gating");
  });

  it("omitting `publish` exercises the module's own default publisher: no throw, state still written (the production wiring — every other case injects a stub, so nothing else covers the default parameter)", () => {
    expect(() =>
      writePhaseState(makeState({ phase: "gating" }), stateDir),
    ).not.toThrow();
    expect(readState("csv-export", stateDir)?.phase).toBe("gating");
  });

  it("no-tmux path: the default publisher driving the real setWindowPhase degrades to {ok:false} without throwing (plain-shell launcher, the default)", () => {
    let observed: { ok: boolean; stderr: string } | undefined;
    const publish: PhasePublisher = (slug, phase) => {
      observed = setWindowPhase(slug, phase, { listWindowsFn: () => [] });
    };
    expect(() =>
      writePhaseState(makeState({ phase: "gating" }), stateDir, publish),
    ).not.toThrow();
    expect(observed?.ok).toBe(false);
    expect(readState("csv-export", stateDir)?.phase).toBe("gating");
  });
});
