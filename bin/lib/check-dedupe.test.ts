import { describe, expect, it } from "vitest";
import {
  checkKey,
  isReadOnlyVerifier,
  runDeduped,
  type DedupableResult,
  type DedupeItem,
} from "./check-dedupe";

type Item = DedupeItem;
type Res = DedupableResult & { passed: boolean; skipReason?: string };

function harness(overrides: Record<string, Partial<Res>> = {}) {
  const calls: string[] = [];
  const execute = (item: Item): Res => {
    calls.push(`${item.scope}:${item.argv.join(" ")}`);
    return {
      name: item.argv.join(" "),
      scope: item.scope,
      durationMs: 100,
      passed: true,
      ...overrides[item.argv.join(" ")],
    };
  };
  return { calls, execute };
}

const item = (scope: string, cmd: string): Item => ({
  scope,
  argv: cmd.split(" "),
});

describe("runDeduped", () => {
  it("executes identical verifier argv once and reuses the result", () => {
    const { calls, execute } = harness();
    const { results, savedMs } = runDeduped(
      [item("src", "npm run test"), item("scripts", "npm run test")],
      execute,
    );
    expect(calls).toEqual(["src:npm run test"]);
    expect(results[1]).toMatchObject({
      scope: "scripts",
      durationMs: 0,
      dedupedFrom: "src",
    });
    expect(results[0].dedupedFrom).toBeUndefined();
    expect(savedMs).toBe(100);
  });

  it("executes differing argv separately and preserves order", () => {
    const { calls, execute } = harness();
    const { results } = runDeduped(
      [
        item("src", "npm run test"),
        item("src", "npm run lint"),
        item("web", "npm run test -w apps/web"),
        item("scripts", "npm run test"),
      ],
      execute,
    );
    expect(calls).toHaveLength(3);
    expect(results.map((r) => r.scope)).toEqual([
      "src",
      "src",
      "web",
      "scripts",
    ]);
  });

  it("copies a failed or skipped first result with its fields intact", () => {
    const { execute } = harness({
      "npm run test": { passed: false },
      actionlint: { skipReason: "actionlint-not-installed" },
    });
    const { results } = runDeduped(
      [
        item("src", "npm run test"),
        item("scripts", "npm run test"),
        item("src", "actionlint"),
        item("docs", "actionlint"),
      ],
      execute,
    );
    expect(results[1].passed).toBe(false);
    expect(results[3].skipReason).toBe("actionlint-not-installed");
    expect(results[3].dedupedFrom).toBe("src");
  });

  it("reuses within a single scope", () => {
    const { calls, execute } = harness();
    const { results, savedMs } = runDeduped(
      [item("src", "npm run lint"), item("src", "npm run lint")],
      execute,
    );
    expect(calls).toHaveLength(1);
    expect(results[1].dedupedFrom).toBe("src");
    expect(savedMs).toBe(100);
  });

  it("treats a non-verifier as a barrier that clears reuse", () => {
    const { calls, execute } = harness();
    runDeduped(
      [
        item("src", "npm run test"),
        item("mid", "npm run generate"),
        item("scripts", "npm run test"),
      ],
      execute,
    );
    expect(calls.filter((c) => c.endsWith("npm run test"))).toHaveLength(2);
  });

  it("executes a repeated non-verifier every time", () => {
    const { calls, execute } = harness();
    runDeduped(
      [item("a", "npm run generate"), item("b", "npm run generate")],
      execute,
    );
    expect(calls).toHaveLength(2);
  });
});

describe("runDeduped with prior results", () => {
  const seed = (cmd: string): Res => ({
    name: cmd,
    scope: "<earlier-run>",
    durationMs: 700,
    passed: true,
  });
  const prior = (cmd: string) =>
    new Map<string, Res>([[checkKey(cmd.split(" ")), seed(cmd)]]);

  it("does not execute a seeded key and labels the reuse with the seed's scope", () => {
    const { calls, execute } = harness();
    const { results, savedMs } = runDeduped(
      [item("src", "npm run test")],
      execute,
      prior("npm run test"),
    );
    expect(calls).toEqual([]);
    expect(results[0]).toMatchObject({
      scope: "src",
      durationMs: 0,
      dedupedFrom: "<earlier-run>",
    });
    expect(savedMs).toBe(700);
  });

  it("clears the seeds after a mutating check", () => {
    const { calls, execute } = harness();
    runDeduped(
      [item("src", "npm run build"), item("src", "npm run test")],
      execute,
      prior("npm run test"),
    );
    expect(calls).toEqual(["src:npm run build", "src:npm run test"]);
  });

  it("leaves the caller's map untouched", () => {
    const seeds = prior("npm run test");
    const { execute } = harness();
    runDeduped(
      [item("src", "npm run build"), item("src", "npm run lint")],
      execute,
      seeds,
    );
    expect(seeds.size).toBe(1);
  });
});

describe("isReadOnlyVerifier", () => {
  const argv = (cmd: string) => cmd.split(" ");
  it.each([
    "npm run test",
    "npm run test -- a.ts --no-isolate",
    "npm run typecheck",
    "npm run typecheck:scripts",
    "npm run check -w apps/web",
    "npm run lint",
    "npm run format:check",
    "npm run test:related -- x.ts",
    "flow-md-validate .",
    "actionlint",
  ])("accepts %s", (cmd) => {
    expect(isReadOnlyVerifier(argv(cmd))).toBe(true);
  });

  it.each([
    [["go", "vet", "-C", "backend", "./..."]],
    [["go", "test", "-C", "backend", "./..."]],
    [["go", "-C", "backend", "vet", "./..."]],
  ])("accepts go argv %j", (a) => {
    expect(isReadOnlyVerifier(a)).toBe(true);
  });

  it.each([
    [argv("npm run build")],
    [argv("npm run generate")],
    [argv("npm install")],
    [["go", "build", "./..."]],
    [[] as string[]],
  ])("rejects %j", (a) => {
    expect(isReadOnlyVerifier(a)).toBe(false);
  });
});
