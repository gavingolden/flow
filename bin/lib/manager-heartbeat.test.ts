import { describe, expect, it } from "vitest";
import type { ExecFn } from "./epic-manage-observe";
import {
  buildMultiRepoPrQuery,
  mergedOutOfBand,
  parseMultiRepoPrResponse,
  runHeartbeat,
} from "./manager-heartbeat";
import type { PipelineState } from "./state";

const st = (
  slug: string,
  pr: number,
  over: Partial<PipelineState> = {},
): PipelineState => ({
  slug,
  phase: "ci-waiting",
  repo: "/r/flow",
  updatedAt: "2026-11-12T00:00:00.000Z",
  pr,
  prUrl: `https://github.com/acme/flow/pull/${pr}`,
  ...over,
});

const response = (states: Record<number, string>) =>
  JSON.stringify({
    data: {
      r0: {
        nameWithOwner: "acme/flow",
        ...Object.fromEntries(
          Object.entries(states).map(([n, state]) => [
            `p${n}`,
            { number: Number(n), state },
          ]),
        ),
      },
    },
  });

describe("multi-repo PR query", () => {
  it("builds one aliased query with a repository alias per repo", () => {
    const q = buildMultiRepoPrQuery([
      { owner: "acme", name: "flow", pr: 1 },
      { owner: "acme", name: "flow", pr: 2 },
      { owner: "acme", name: "other", pr: 3 },
    ]);
    expect(q.match(/repository\(/g)).toHaveLength(2);
    expect(q).toContain("p1: pullRequest(number: 1)");
    expect(q).toContain("p3: pullRequest(number: 3)");
  });

  it("parses states keyed by owner/name#n and tolerates null aliases and bad JSON", () => {
    const m = parseMultiRepoPrResponse(
      JSON.stringify({
        data: {
          r0: {
            nameWithOwner: "Acme/Flow",
            p1: { number: 1, state: "MERGED" },
            p2: null,
          },
        },
      }),
    );
    expect([...m]).toEqual([["acme/flow#1", "MERGED"]]);
    expect(parseMultiRepoPrResponse("nope").size).toBe(0);
  });
});

describe("mergedOutOfBand", () => {
  const merged = new Map([["acme/flow#1", "MERGED" as const]]);

  it("does not call a pipeline's own merge out of band while it is merging", () => {
    expect(mergedOutOfBand([st("a", 1, { phase: "merging" })], merged)).toEqual(
      [],
    );
    expect(
      mergedOutOfBand([st("a", 1, { phase: "ci-waiting" })], merged),
    ).toHaveLength(1);
  });

  it("still reports a PR closed without merging while the pipeline is merging", () => {
    const closed = new Map([["acme/flow#1", "CLOSED" as const]]);
    expect(
      mergedOutOfBand([st("a", 1, { phase: "merging" })], closed),
    ).toHaveLength(1);
  });
});

describe("runHeartbeat", () => {
  it("makes exactly one gh call and reports an unfinished pipeline whose PR merged", async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, args]);
      return {
        exitCode: 0,
        stdout: response({ 1: "MERGED", 2: "OPEN" }),
        stderr: "",
      };
    };
    const events = await runHeartbeat([st("a", 1), st("b", 2)], exec);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("gh");
    expect(
      calls.some(([c]) => c === "claude" || c.includes("flow-claude-headless")),
    ).toBe(false);
    expect(events).toEqual([
      { kind: "merged-out-of-band", slug: "a", repo: "flow", to: "MERGED" },
    ]);
  });

  it("skips finished pipelines and makes no call when there is nothing to ask", async () => {
    let n = 0;
    const exec: ExecFn = async () => {
      n++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runHeartbeat([st("a", 1, { phase: "merged" })], exec)).toEqual(
      [],
    );
    expect(n).toBe(0);
  });
});
