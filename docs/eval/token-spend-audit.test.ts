import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { selfTest } from "./token-spend-audit";

describe("token-spend-audit self-test", () => {
  it("should pass every in-memory replay and pricing fixture", () => {
    expect(selfTest()).toEqual([]);
  });
});

const home = mkdtempSync(join(tmpdir(), "token-spend-audit-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const usage = (read: number, w1: number) => ({
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: w1,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: w1,
  },
});

// A user row followed by an assistant row: the user row is the send time.
const exchange = (id: string, sent: string, replied: string, u: object) => [
  JSON.stringify({ type: "user", timestamp: sent }),
  JSON.stringify({
    type: "assistant",
    timestamp: replied,
    cwd: "/u/code/me/flow",
    message: { id, model: "claude-opus-5", usage: u, content: [] },
  }),
];

describe("token-spend-audit cache-lifetime table over a fixture home", () => {
  it("should price a 1h write re-read 20 minutes later for the main conversation and a sub-agent", () => {
    const proj = join(home, ".claude", "projects", "-u-code-me-flow");
    const subDir = join(proj, "S", "subagents");
    mkdirSync(subDir, { recursive: true });
    const lines = (p: string, i: string) =>
      [
        ...exchange(
          `${p}1`,
          "2026-09-10T00:00:00Z",
          "2026-09-10T00:00:30Z",
          usage(0, 1e6),
        ),
        ...exchange(
          `${p}2`,
          "2026-09-10T00:20:00Z",
          "2026-09-10T00:20:10Z",
          usage(2e6, 0),
        ),
      ].join("\n") + i;
    writeFileSync(join(proj, "S.jsonl"), lines("m", "\n"));
    writeFileSync(join(subDir, "a.jsonl"), lines("s", "\n"));
    writeFileSync(
      join(subDir, "a.meta.json"),
      JSON.stringify({ agentType: "flow-discovery" }),
    );

    const r = spawnSync(
      "bun",
      [join(__dirname, "token-spend-audit.ts"), "--home", home],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const out = r.stdout;
    const section = out.slice(out.indexOf("## Cache lifetime"));
    expect(section).toContain(
      "## Cache lifetime: 1-hour writes re-read after five minutes",
    );
    const cells = (label: string) =>
      section
        .split("\n")
        .find((l) => l.startsWith(`| ${label} |`))
        ?.split("|")
        .map((c) => c.trim());
    // ["", stream, requests, 1h tokens, 1h $, premium, re-read, cross-spawn, requests re-reading, re-write $, net, net (assistant row)]
    for (const label of ["main conversation", "sub-agent: flow-discovery"]) {
      const c = cells(label);
      expect(c, label).toBeDefined();
      expect(c![2], `${label} requests`).toBe("2");
      expect(c![6], `${label} re-read tokens`).toBe("2.00M");
      expect(c![8], `${label} requests re-reading`).toBe("1");
      expect(c![7], `${label} cross-spawn tokens`).toBe("0.00M");
      expect(c![10], `${label} net at 5m`).toBe("$7.75");
      expect(c![11], `${label} net at 5m, assistant-row`).toBe("$7.75");
    }

    const first = out.slice(
      out.indexOf("## First-turn cache-write per sub-agent type"),
    );
    const firstLines = first.split("\n");
    expect(firstLines[2]).toContain("median read tokens");
    expect(firstLines[2]).toContain("zero-read first turns");
    const row = firstLines
      .find((l) => l.startsWith("| flow-discovery |"))
      ?.split("|")
      .map((c) => c.trim());
    expect(row).toBeDefined();
    // ["", type, transcripts, median write, mean write, median read, zero-read, ""]
    expect(row![2], "first-turn transcripts").toBe("1");
    expect(row![5], "first-turn median read").toBe("0");
    expect(row![6], "first-turn zero-read count").toBe("1");
  });
});
