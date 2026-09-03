/**
 * Direct coverage for `eval-args.ts`'s `run` parser — `bin/flow-eval.ts`
 * only exercises it indirectly. `--ablation`'s reject path has no other
 * natural home since it never reaches `bin/flow-eval.test.ts`'s
 * higher-level `Deps`-injected assertions.
 */

import { describe, expect, it } from "vitest";
import { parseArgs, type RunArgs } from "./eval-args";

function baseRunArgv(extra: string[] = []): string[] {
  return ["run", "--suite", "s1", "--out", ".flow-tmp/eval", ...extra];
}

describe("parseArgs 'run' --ablation", () => {
  it("defaults to 'none' when the flag is omitted", () => {
    const parsed = parseArgs(baseRunArgv());
    expect("error" in parsed).toBe(false);
    expect((parsed as RunArgs).ablation).toBe("none");
  });

  it("accepts --ablation none explicitly", () => {
    const parsed = parseArgs(baseRunArgv(["--ablation", "none"]));
    expect("error" in parsed).toBe(false);
    expect((parsed as RunArgs).ablation).toBe("none");
  });

  it("accepts --ablation with-without", () => {
    const parsed = parseArgs(baseRunArgv(["--ablation", "with-without"]));
    expect("error" in parsed).toBe(false);
    expect((parsed as RunArgs).ablation).toBe("with-without");
  });

  it("rejects any other value with the exact usage message", () => {
    const parsed = parseArgs(baseRunArgv(["--ablation", "bogus"]));
    expect(parsed).toEqual({
      error: "--ablation must be none or with-without",
    });
  });
});
