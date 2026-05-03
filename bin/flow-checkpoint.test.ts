import { describe, expect, it } from "vitest";
import { buildLines, parseArgs, run } from "./flow-checkpoint";

describe("parseArgs", () => {
  it("requires --from", () => {
    expect(parseArgs(["--to", "step-5"])).toEqual({ error: "--from is required" });
  });

  it("requires --to", () => {
    expect(parseArgs(["--from", "step-3"])).toEqual({ error: "--to is required" });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--bogus", "x"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("rejects an unknown flag even when no value follows it", () => {
    // Without the unknown-flag check running before the value-presence check,
    // `["--bogus"]` would mis-report `--bogus requires a value` and bury the
    // real cause (the flag is unrecognised, value or no value).
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("rejects a flag with no value", () => {
    expect(parseArgs(["--from"])).toEqual({ error: "--from requires a value" });
  });

  it("rejects a flag whose value is the next flag", () => {
    expect(parseArgs(["--from", "--to"])).toEqual({ error: "--from requires a value" });
  });

  it("parses a minimal arg set", () => {
    expect(parseArgs(["--from", "step-3", "--to", "step-5"])).toEqual({
      from: "step-3",
      to: "step-5",
    });
  });

  it("parses a full arg set with note", () => {
    expect(
      parseArgs([
        "--from",
        "step-3",
        "--to",
        "step-5",
        "--note",
        "/product-planning returned",
      ]),
    ).toEqual({
      from: "step-3",
      to: "step-5",
      note: "/product-planning returned",
    });
  });
});

describe("buildLines", () => {
  it("emits the transition line and the reminder line", () => {
    expect(buildLines({ from: "step-3", to: "step-5" })).toEqual([
      "flow-checkpoint: returning from step-3 → continuing to step-5",
      "DO NOT END THE TURN",
    ]);
  });

  it("includes a note line between transition and reminder when --note is given", () => {
    expect(
      buildLines({
        from: "step-3",
        to: "step-5",
        note: "/product-planning returned",
      }),
    ).toEqual([
      "flow-checkpoint: returning from step-3 → continuing to step-5",
      "note: /product-planning returned",
      "DO NOT END THE TURN",
    ]);
  });

  it("collapses newlines in the note so the reminder always lands on its own line", () => {
    expect(
      buildLines({
        from: "step-6",
        to: "step-7",
        note: "verify\npassed\non third try",
      }),
    ).toEqual([
      "flow-checkpoint: returning from step-6 → continuing to step-7",
      "note: verify passed on third try",
      "DO NOT END THE TURN",
    ]);
  });

  it("ignores a whitespace-only note", () => {
    expect(buildLines({ from: "step-3", to: "step-5", note: "   " })).toEqual([
      "flow-checkpoint: returning from step-3 → continuing to step-5",
      "DO NOT END THE TURN",
    ]);
  });
});

describe("run", () => {
  it("writes every line to stderr followed by a newline", () => {
    const writes: string[] = [];
    const exit = run(
      ["--from", "step-3", "--to", "step-5"],
      { writeErr: (s) => writes.push(s) },
    );
    expect(exit).toBe(0);
    expect(writes).toEqual([
      "flow-checkpoint: returning from step-3 → continuing to step-5\n",
      "DO NOT END THE TURN\n",
    ]);
  });

  it("exits 0 even on success — never a gate", () => {
    const exit = run(
      ["--from", "step-3", "--to", "step-5"],
      { writeErr: () => {} },
    );
    expect(exit).toBe(0);
  });

  it("exits 2 on argument-parse error so misuse is loud", () => {
    const exit = run(["--bogus", "x"], { writeErr: () => {} });
    expect(exit).toBe(2);
  });
});
