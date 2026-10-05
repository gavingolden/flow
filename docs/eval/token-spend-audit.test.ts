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
  });
});

describe("token-spend-audit per-phase table over a fixture home", () => {
  it("should attribute two turns either side of a phase transition to different phases", () => {
    const phaseHome = mkdtempSync(join(tmpdir(), "token-spend-phase-"));
    try {
      const proj = join(phaseHome, ".claude", "projects", "-u-code-me-flow");
      mkdirSync(proj, { recursive: true });
      writeFileSync(
        join(proj, "P.jsonl"),
        [
          ...exchange(
            "p1",
            "2026-09-10T00:00:00Z",
            "2026-09-10T00:00:30Z",
            usage(0, 1e6),
          ),
          ...exchange(
            "p2",
            "2026-09-10T00:20:00Z",
            "2026-09-10T00:20:10Z",
            usage(2e6, 0),
          ),
        ].join("\n") + "\n",
      );
      const tele = join(phaseHome, ".flow", "telemetry");
      mkdirSync(tele, { recursive: true });
      const transition = (ts: string, from: string, to: string) =>
        JSON.stringify({
          ts,
          event: "phase.transition",
          slug: "demo",
          repo: "/u/code/me/flow",
          session_id: "P",
          attrs: { from, to },
        });
      writeFileSync(
        join(tele, "events.jsonl"),
        [
          transition("2026-09-09T23:59:00Z", "planning", "implementing"),
          transition("2026-09-10T00:10:00Z", "implementing", "reviewing"),
        ].join("\n") + "\n",
      );

      const r = spawnSync(
        "bun",
        [join(__dirname, "token-spend-audit.ts"), "--home", phaseHome],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      const out = r.stdout;
      const start = out.indexOf("## Supervisor spend by pipeline phase");
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = out.slice(start + 1);
      const next = rest.indexOf("\n## ");
      const section =
        next < 0 ? out.slice(start) : out.slice(start, start + 1 + next);
      const rows = section
        .split("\n")
        .filter((l) => l.startsWith("| ") && !l.startsWith("| phase |"))
        .map((l) => l.split("|").map((c) => c.trim()));
      // ["", phase, pipelines, turns, turns per pipeline, mean context, $, % of $, mean $ per pipeline, largest in N]
      expect(rows.map((c) => [c[1], c[2], c[3]])).toEqual([
        ["implementing", "1", "1"],
        ["reviewing", "1", "1"],
      ]);
      // The 1h write ($10) before the transition outweighs the re-read ($1) after it.
      expect(rows[0][9]).toBe("1");
      expect(rows[1][9]).toBe("0");
    } finally {
      rmSync(phaseHome, { recursive: true, force: true });
    }
  });
});
