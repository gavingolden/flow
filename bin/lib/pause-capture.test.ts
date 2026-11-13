import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointDir } from "./checkpoint-freshness";
import {
  parsePauseSlots,
  readLastPause,
  recordLastPause,
} from "./pause-capture";
import { writeState, type PipelineState } from "./state";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pausecap-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const BLOCK = `Some closing prose above the block.

### ⏸ GATED — manual validation needed

**TLDR:** Gated: the export button used to hang; now it streams.

**Needs attention:**
- Click Export on /reports and confirm the file opens.
- Subjective: copy reads well.

**Manual action:** before merge: tick the Test Steps.

**Next action:** tick the Test Steps boxes and say \`merge\`.
`;

const state = (over: Partial<PipelineState> = {}): PipelineState => ({
  slug: "demo",
  phase: "gated",
  repo: "/r/flow",
  updatedAt: "2026-11-12T00:00:10.000Z",
  phaseLog: [
    { phase: "gating", at: "2026-11-12T00:00:00.000Z" },
    { phase: "gated", at: "2026-11-12T00:00:05.000Z" },
  ],
  ...over,
});
const file = () => path.join(checkpointDir("demo", dir), "last-pause.json");

describe("parsePauseSlots", () => {
  it("should read every labeled slot, multi-line bodies included", () => {
    expect(parsePauseSlots(BLOCK)).toEqual({
      tldr: "Gated: the export button used to hang; now it streams.",
      needsAttention:
        "- Click Export on /reports and confirm the file opens.\n- Subjective: copy reads well.",
      manualAction: "before merge: tick the Test Steps.",
      nextAction: "tick the Test Steps boxes and say `merge`.",
    });
  });

  it("should take the last block when a message holds two", () => {
    const two = `**TLDR:** old.\n\n**Next action:** old reply\n\nmore work\n\n**TLDR:** new.\n\n**Next action:** new reply`;
    expect(parsePauseSlots(two)).toEqual({
      tldr: "new.",
      nextAction: "new reply",
    });
  });

  it("should accept a block with only a Next action", () => {
    expect(parsePauseSlots("**Next action:** say done")).toEqual({
      nextAction: "say done",
    });
  });

  it("should return null for a message with no TLDR and no Next action", () => {
    expect(parsePauseSlots("just prose")).toBeNull();
    expect(parsePauseSlots("**Unsolved:** a fork")).toBeNull();
    expect(parsePauseSlots("")).toBeNull();
  });

  it("should stop a slot at the next heading", () => {
    const m = "**TLDR:** one.\n\n### Later\n\nunrelated\n\n**Next action:** go";
    expect(parsePauseSlots(m)).toEqual({ tldr: "one.", nextAction: "go" });
  });
});

describe("recordLastPause and readLastPause", () => {
  it("should save the block with the phase and the phase-entered time and read it back", () => {
    writeState(state(), dir);
    recordLastPause("demo", "gated", BLOCK, dir);
    expect(readLastPause("demo", dir)).toMatchObject({
      phase: "gated",
      at: "2026-11-12T00:00:05.000Z",
      tldr: "Gated: the export button used to hang; now it streams.",
      nextAction: "tick the Test Steps boxes and say `merge`.",
    });
  });

  it("should write nothing for a message with no pause block", () => {
    writeState(state(), dir);
    recordLastPause("demo", "gated", "just prose", dir);
    recordLastPause("demo", "gated", undefined, dir);
    expect(fs.existsSync(file())).toBe(false);
    expect(readLastPause("demo", dir)).toBeNull();
  });

  it("should return null once the state has moved to another phase", () => {
    writeState(state(), dir);
    recordLastPause("demo", "gated", BLOCK, dir);
    writeState(state({ phase: "merged" }), dir);
    expect(readLastPause("demo", dir)).toBeNull();
  });

  it("should return null for an earlier pause at the same phase", () => {
    writeState(state(), dir);
    recordLastPause("demo", "gated", BLOCK, dir);
    writeState(
      state({
        phaseLog: [
          { phase: "gated", at: "2026-11-12T00:00:05.000Z" },
          { phase: "reviewing", at: "2026-11-12T00:01:00.000Z" },
          { phase: "gated", at: "2026-11-12T00:02:00.000Z" },
        ],
      }),
      dir,
    );
    expect(readLastPause("demo", dir)).toBeNull();
  });

  it("should not record when the state is not at the named phase or is gone", () => {
    writeState(state({ phase: "implementing" }), dir);
    recordLastPause("demo", "gated", BLOCK, dir);
    expect(fs.existsSync(file())).toBe(false);
    recordLastPause("ghost", "gated", BLOCK, dir);
  });

  it("should never throw, even for an invalid slug", () => {
    expect(() => recordLastPause("../x", "gated", BLOCK, dir)).not.toThrow();
    expect(readLastPause("../x", dir)).toBeNull();
  });

  it("should read a corrupt record as null", () => {
    writeState(state(), dir);
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), "{broken");
    expect(readLastPause("demo", dir)).toBeNull();
  });
});
