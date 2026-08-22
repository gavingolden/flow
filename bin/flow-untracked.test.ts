import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readState, writeState, type PipelineState } from "./lib/state";
import {
  UNTRACKED_RENDER_CAP,
  addItem,
  dropItem,
  fileItem,
  renderGate,
  renderMarkdown,
  run,
} from "./flow-untracked";

let dir: string;
const BASE: PipelineState = {
  slug: "s1",
  phase: "gated",
  repo: "/tmp/repo",
  updatedAt: "2026-05-17T00:00:00Z",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-untracked-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(state: PipelineState) {
  writeState(state, dir);
}

const now = () => "2026-05-17T00:05:00Z";

// --- Pure mutators ---

describe("addItem", () => {
  it("assigns id 1 to the first item and never renumbers", () => {
    let s = addItem(BASE, { title: "a", source: "pr-review" }, now);
    expect(s.untracked).toEqual([
      { id: 1, title: "a", source: "pr-review", at: now() },
    ]);
    s = addItem(s, { title: "b", source: "verify" }, now);
    expect(s.untracked?.[1]).toEqual({
      id: 2,
      title: "b",
      source: "verify",
      at: now(),
    });
  });

  it("keeps assigning the next-highest id even after drops", () => {
    let s = addItem(BASE, { title: "a", source: "x" }, now);
    s = dropItem(s, 1, now);
    s = addItem(s, { title: "b", source: "x" }, now);
    expect(s.untracked?.map((i) => i.id)).toEqual([1, 2]);
  });

  it("carries an optional body", () => {
    const s = addItem(BASE, { title: "a", body: "detail", source: "x" }, now);
    expect(s.untracked?.[0].body).toBe("detail");
  });
});

describe("fileItem", () => {
  it("records filedAs from the createIssue callback", () => {
    const s0 = addItem(BASE, { title: "a", source: "x" }, now);
    const s1 = fileItem(s0, 1, () => ({
      url: "https://github.com/gavingolden/flow/issues/1",
    }));
    expect(s1.untracked?.[0].filedAs).toBe(
      "https://github.com/gavingolden/flow/issues/1",
    );
  });

  it("is idempotent — a second file call does not re-invoke createIssue", () => {
    const s0 = addItem(BASE, { title: "a", source: "x" }, now);
    const s1 = fileItem(s0, 1, () => ({ url: "https://x/1" }));
    let calls = 0;
    const s2 = fileItem(s1, 1, () => {
      calls++;
      return { url: "https://x/should-not-happen" };
    });
    expect(calls).toBe(0);
    expect(s2).toEqual(s1);
  });

  it("throws on an unknown id", () => {
    expect(() => fileItem(BASE, 99, () => ({ url: "x" }))).toThrow(/#99/);
  });
});

describe("dropItem", () => {
  it("records droppedAt", () => {
    const s0 = addItem(BASE, { title: "a", source: "x" }, now);
    const s1 = dropItem(s0, 1, now);
    expect(s1.untracked?.[0].droppedAt).toBe(now());
  });

  it("throws on an unknown id", () => {
    expect(() => dropItem(BASE, 99, now)).toThrow(/#99/);
  });
});

// --- Pure renderers ---

describe("renderGate / renderMarkdown", () => {
  const items = [
    { id: 1, title: "first", source: "x", at: "2026-05-17T00:00:00Z" },
    { id: 2, title: "second", source: "x", at: "2026-05-17T00:01:00Z" },
    { id: 3, title: "third", source: "x", at: "2026-05-17T00:02:00Z" },
  ];

  it("caps at UNTRACKED_RENDER_CAP most-recent-first and appends an overflow tail", () => {
    expect(UNTRACKED_RENDER_CAP).toBe(2);
    const lines = renderGate(items);
    expect(lines).toEqual([
      "  - #3 third (reply: file #3 / drop #3)",
      "  - #2 second (reply: file #2 / drop #2)",
      "  (+1 more — flow-untracked list)",
    ]);
  });

  it("omits the overflow tail when at or under the cap", () => {
    expect(renderGate(items.slice(0, 2))).toEqual([
      "  - #2 second (reply: file #2 / drop #2)",
      "  - #1 first (reply: file #1 / drop #1)",
    ]);
  });

  it("renderMarkdown uses the plain bullet form", () => {
    expect(renderMarkdown(items.slice(0, 1))).toEqual(["- #1 first"]);
  });

  it("renders nothing for an empty list", () => {
    expect(renderGate([])).toEqual([]);
    expect(renderMarkdown([])).toEqual([]);
  });
});

// --- CLI: run(argv, deps) ---

describe("run", () => {
  it("add records an item on state.json", () => {
    seed(BASE);
    const code = run(
      ["add", "--title", "found a bug", "--source", "pr-review"],
      { resolveSlug: () => "s1", stateDir: dir, now },
    );
    expect(code).toBe(0);
    const state = readState("s1", dir);
    expect(state?.untracked).toEqual([
      { id: 1, title: "found a bug", source: "pr-review", at: now() },
    ]);
  });

  it("add fails with exit 2 when --title is missing", () => {
    seed(BASE);
    const code = run(["add", "--source", "pr-review"], {
      resolveSlug: () => "s1",
      stateDir: dir,
    });
    expect(code).toBe(2);
  });

  it("add fails with exit 2 when there is no state file", () => {
    const code = run(["add", "--title", "t", "--source", "s"], {
      resolveSlug: () => "missing",
      stateDir: dir,
    });
    expect(code).toBe(2);
  });

  it("list prints nothing when state is absent", () => {
    const lines: string[] = [];
    const code = run(["list"], {
      resolveSlug: () => "missing",
      stateDir: dir,
      out: (s) => lines.push(s),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it("list --json prints the raw items", () => {
    seed(addItem(BASE, { title: "a", source: "x" }, now));
    const lines: string[] = [];
    run(["list", "--json"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      out: (s) => lines.push(s),
    });
    expect(JSON.parse(lines[0])).toEqual([
      { id: 1, title: "a", source: "x", at: now() },
    ]);
  });

  it("file is idempotent and records filedAs via the injected createIssue", () => {
    seed(addItem(BASE, { title: "a", source: "x" }, now));
    let calls = 0;
    const deps = {
      resolveSlug: () => "s1",
      stateDir: dir,
      createIssue: () => {
        calls++;
        return { url: "https://x/1" };
      },
    };
    expect(run(["file", "1"], deps)).toBe(0);
    expect(run(["file", "1"], deps)).toBe(0);
    expect(calls).toBe(1);
    expect(readState("s1", dir)?.untracked?.[0].filedAs).toBe("https://x/1");
  });

  it("file on an unknown id fails with exit 2 (bad-args contract, not the flow-create-issue exit)", () => {
    seed(BASE);
    const code = run(["file", "99"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      createIssue: () => ({ url: "https://x/should-not-happen" }),
    });
    expect(code).toBe(2);
  });

  it("file fails with exit 1 when the injected createIssue throws (flow-create-issue failed)", () => {
    seed(addItem(BASE, { title: "a", source: "x" }, now));
    const code = run(["file", "1"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      createIssue: () => {
        throw new Error("flow-create-issue exited 1: no gh auth");
      },
    });
    expect(code).toBe(1);
  });

  it("list (plain text) appends the filed/dropped suffix", () => {
    let s = addItem(BASE, { title: "unfiled", source: "x" }, now);
    s = addItem(s, { title: "filed", source: "x" }, now);
    s = fileItem(s, 2, () => ({ url: "https://x/2" }));
    s = addItem(s, { title: "dropped", source: "x" }, now);
    s = dropItem(s, 3, now);
    seed(s);
    const lines: string[] = [];
    run(["list"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      out: (l) => lines.push(l),
    });
    const text = lines.join("");
    expect(text).toContain("#1 unfiled\n");
    expect(text).toContain("#2 filed (filed: https://x/2)");
    expect(text).toContain("#3 dropped (dropped)");
  });

  it("drop records droppedAt", () => {
    seed(addItem(BASE, { title: "a", source: "x" }, now));
    const code = run(["drop", "1"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      now,
    });
    expect(code).toBe(0);
    expect(readState("s1", dir)?.untracked?.[0].droppedAt).toBe(now());
  });

  it("drop on an unknown id fails with exit 2", () => {
    seed(BASE);
    const code = run(["drop", "99"], {
      resolveSlug: () => "s1",
      stateDir: dir,
    });
    expect(code).toBe(2);
  });

  it("render --format gate prints nothing/none-safe when there is no state", () => {
    const lines: string[] = [];
    const code = run(["render", "--format", "gate"], {
      resolveSlug: () => "missing",
      stateDir: dir,
      out: (s) => lines.push(s),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it("render --unfiled-only excludes filed items", () => {
    let s = addItem(BASE, { title: "unfiled", source: "x" }, now);
    s = addItem(s, { title: "filed", source: "x" }, now);
    s = fileItem(s, 2, () => ({ url: "https://x/2" }));
    seed(s);
    const lines: string[] = [];
    run(["render", "--format", "gate", "--unfiled-only"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      out: (l) => lines.push(l),
    });
    expect(lines.join("")).toContain("#1 unfiled");
    expect(lines.join("")).not.toContain("#2 filed");
  });

  it("render never shows a dropped item, even without --unfiled-only", () => {
    let s = addItem(BASE, { title: "kept", source: "x" }, now);
    s = addItem(s, { title: "gone", source: "x" }, now);
    s = dropItem(s, 2, now);
    seed(s);
    const lines: string[] = [];
    run(["render", "--format", "markdown"], {
      resolveSlug: () => "s1",
      stateDir: dir,
      out: (l) => lines.push(l),
    });
    expect(lines.join("")).toContain("#1 kept");
    expect(lines.join("")).not.toContain("#2 gone");
  });

  it("an unresolvable slug degrades render to none-safe, not an error", () => {
    const lines: string[] = [];
    const code = run(["render", "--format", "gate"], {
      resolveSlug: () => null,
      stateDir: dir,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it("an unknown subcommand fails with exit 2", () => {
    expect(run(["bogus"], { resolveSlug: () => "s1", stateDir: dir })).toBe(2);
  });
});
