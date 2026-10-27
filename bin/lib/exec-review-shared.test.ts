import { describe, expect, it } from "vitest";
import { execHeadlessArgv, parseHeadlessStdout } from "./exec-review-shared";

describe("parseHeadlessStdout", () => {
  it("reads the last JSON line even when progress follows or precedes it", () => {
    expect(parseHeadlessStdout('progress\n{"ran":true}\n')).toEqual({
      ran: true,
    });
    expect(parseHeadlessStdout('{"ran":false}\n{"ran":true}\n\n')).toEqual({
      ran: true,
    });
  });

  it("treats empty output as an empty envelope, which the reviews skip on", () => {
    expect(parseHeadlessStdout("")).toEqual({});
    expect(parseHeadlessStdout("  \n \n")).toEqual({});
  });

  it("maps garbage or a non-object JSON line to a headless-error skip", () => {
    const skip = { ran: false, skipReason: "headless-error" };
    expect(parseHeadlessStdout("not json")).toEqual(skip);
    expect(parseHeadlessStdout('{"ran":true}\ntrailing prose')).toEqual(skip);
    expect(parseHeadlessStdout("null")).toEqual(skip);
    expect(parseHeadlessStdout("42")).toEqual(skip);
  });
});

describe("execHeadlessArgv", () => {
  it("carries the spend cap, read-only tools, and the task tag for both reviews", () => {
    const argv = execHeadlessArgv({
      promptPath: "/p/prompt.md",
      out: "/p/out.json",
      decisionId: "plan-1",
      model: "opus",
      effort: "high",
    });
    const at = (f: string) => argv[argv.indexOf(f) + 1];
    expect(at("--prompt-file")).toBe("/p/prompt.md");
    expect(at("--out")).toBe("/p/out.json");
    expect(at("--task")).toBe("exec-review-plan-1");
    expect(at("--allowed-tools")).toBe("Read,Grep,Glob");
    expect(at("--timeout-sec")).toBe("480");
    expect(at("--model")).toBe("opus");
    expect(at("--effort")).toBe("high");
    expect(Number(at("--max-budget-usd"))).toBeGreaterThan(0);
  });
});
