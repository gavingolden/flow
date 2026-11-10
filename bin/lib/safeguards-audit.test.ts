import { describe, expect, it } from "vitest";
import { auditTranscripts, type TranscriptFile } from "./safeguards-audit";

const STOP =
  "API Error: Opus 5.5's safeguards flagged this message. Request ID: req_abc123";
const pad = () => " ".repeat(1500);

function line(content: unknown, ts = "2026-11-05T10:00:00Z"): string {
  return JSON.stringify({
    timestamp: ts,
    message: { role: "user", content },
  });
}
function stopLine(ts = "2026-11-05T10:00:00Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "assistant",
    isApiErrorMessage: true,
    message: { role: "assistant", content: [{ type: "text", text: STOP }] },
  });
}
const toolResult = (text: string) => [
  { type: "tool_result", content: [{ type: "text", text }] },
];

function file(name: string, lines: string[], mtime = new Date("2026-11-05")) {
  return { name, text: lines.join("\n"), mtime } as TranscriptFile;
}

describe("auditTranscripts", () => {
  it("accepts a lazy iterable and resolves agent types from a meta file seen last", () => {
    function* lazy(): Generator<TranscriptFile> {
      yield file("agent-9.jsonl", [line(toolResult(`a${pad()}b`)), stopLine()]);
      yield {
        name: "agent-9.meta.json",
        text: '{"agentType":"reviewer"}',
        mtime: new Date("2026-11-05"),
      };
    }
    const res = auditTranscripts(lazy(), {});
    expect(res.agents).toEqual([
      {
        agentType: "reviewer",
        runs: 1,
        padded: 1,
        stopped: 1,
        stoppedPadded: 1,
      },
    ]);
  });

  it("counts a padded run whose padding sits in a non-message line", () => {
    const res = auditTranscripts(
      [file("agent-n.jsonl", [JSON.stringify({ note: `x${pad()}y` })])],
      {},
    );
    expect(res.windows[1]).toMatchObject({ runs: 1, padded: 1 });
  });

  it("splits runs into windows and counts padded and stopped", () => {
    const res = auditTranscripts(
      [
        file("agent-1.jsonl", [line("hi", "2026-10-20T00:00:00Z")]),
        file("agent-2.jsonl", [line(toolResult(`x${pad()}y`)), stopLine()]),
        file("agent-3.jsonl", [line("clean")]),
      ],
      {},
    );
    const [before, after] = res.windows;
    expect(before).toMatchObject({ runs: 1, padded: 0, stopped: 0 });
    expect(after).toMatchObject({
      runs: 2,
      padded: 1,
      stopped: 1,
      stoppedPadded: 1,
    });
  });

  it("classifies the padding route as read or injection", () => {
    const res = auditTranscripts(
      [
        file("agent-r.jsonl", [line(toolResult(`a${pad()}b`)), stopLine()]),
        file("agent-i.jsonl", [
          line(`<system-reminder>rules ${pad()} end</system-reminder>`),
          stopLine(),
        ]),
      ],
      {},
    );
    expect(res.windows[1]).toMatchObject({
      stoppedViaRead: 1,
      stoppedViaInjection: 1,
    });
  });

  it("reads the agent type from a sibling meta file and honours since", () => {
    const res = auditTranscripts(
      [
        file("agent-9.jsonl", [line("hi")]),
        {
          name: "agent-9.meta.json",
          text: JSON.stringify({ agentType: "flow:coder" }),
          mtime: new Date(),
        },
        file("agent-old.jsonl", [line("hi", "2026-09-01T00:00:00Z")]),
      ],
      { since: new Date("2026-10-01") },
    );
    expect(res.agents).toEqual([
      {
        agentType: "flow:coder",
        runs: 1,
        padded: 0,
        stopped: 0,
        stoppedPadded: 0,
      },
    ]);
  });

  it("counts only the agent's own stop entry, never a quoted error", () => {
    const res = auditTranscripts(
      [
        file("agent-q.jsonl", [line(`the reviewer failed: ${STOP}`)]),
        file("agent-late.jsonl", [stopLine(), line(toolResult(`a${pad()}b`))]),
      ],
      {},
    );
    expect(res.windows[1]).toMatchObject({
      runs: 2,
      stopped: 1,
      stoppedPadded: 0,
    });
  });

  it("never returns request ids or file contents", () => {
    const res = auditTranscripts([file("agent-s.jsonl", [stopLine()])], {});
    expect(JSON.stringify(res)).not.toContain("req_abc123");
  });
});
