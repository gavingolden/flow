import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./flow-manager-note";
import { readNotes } from "./lib/manager-notes";
import { writeState } from "./lib/state";

let root: string;
let stateDir: string;
let home: string;
let printed: string[];
let errors: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mnote-"));
  stateDir = path.join(root, "state");
  home = path.join(root, "manager");
  printed = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a) => {
    printed.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a) => {
    errors.push(a.join(" "));
  });
  const seed = (slug: string, phase: string) =>
    writeState(
      {
        slug,
        phase,
        repo: "/r/flow",
        updatedAt: "2026-10-26T00:00:00.000Z",
      },
      stateDir,
    );
  seed("live", "implementing");
  seed("waiting", "gated");
  seed("done", "merged");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = (args: string[]) => run(args, { stateDir, home });

describe("add", () => {
  it("appends a note about a live pipeline and prints one JSON line", () => {
    expect(
      call(["add", "--about", "live", "--text", "hold w until z lands"]),
    ).toBe(0);
    expect(printed).toHaveLength(1);
    const o = JSON.parse(printed[0]);
    expect(o).toMatchObject({ ok: true, about: ["live"], repo: "flow" });
    expect(readNotes(home)).toHaveLength(1);
    expect(readNotes(home)[0]).toMatchObject({
      id: o.id,
      text: "hold w until z lands",
    });
  });

  it("stamps the author: manager when FLOW_MANAGER=1, else the pipeline slug, else owner", () => {
    const as = (env: NodeJS.ProcessEnv) =>
      run(["add", "--about", "live", "--text", "x"], { stateDir, home, env });
    as({ FLOW_MANAGER: "1", FLOW_SLUG: "ignored" });
    as({ FLOW_SLUG: "waiting" });
    as({});
    expect(readNotes(home).map((n) => n.author)).toEqual([
      "manager",
      "waiting",
      "owner",
    ]);
  });

  it("succeeds with one live slug and one already-merged slug", () => {
    expect(call(["add", "--about", "done,waiting", "--text", "x"])).toBe(0);
    expect(readNotes(home)[0].about).toEqual(["done", "waiting"]);
  });

  it("refuses, exit 2 and nothing written, when no named slug is live and unfinished", () => {
    expect(call(["add", "--about", "done", "--text", "x"])).toBe(2);
    expect(call(["add", "--about", "ghost", "--text", "x"])).toBe(2);
    expect(printed).toEqual([]);
    expect(fs.existsSync(path.join(home, "notes.jsonl"))).toBe(false);
  });

  it("refuses empty and over-1000-character text", () => {
    expect(call(["add", "--about", "live", "--text", "   "])).toBe(2);
    expect(call(["add", "--about", "live", "--text", "x".repeat(1001)])).toBe(
      2,
    );
    expect(call(["add", "--about", "live", "--text", "x".repeat(1000)])).toBe(
      0,
    );
    expect(readNotes(home)).toHaveLength(1);
  });

  it("refuses missing flags, unknown flags and unknown subcommands", () => {
    expect(call(["add", "--text", "x"])).toBe(2);
    expect(call(["add", "--about", "live"])).toBe(2);
    expect(call(["add", "--wat", "x"])).toBe(2);
    expect(call(["bogus"])).toBe(2);
    expect(call([])).toBe(2);
  });
});

describe("list", () => {
  it("lists every note or only those about a slug", () => {
    call(["add", "--about", "live", "--text", "a"]);
    call(["add", "--about", "waiting", "--text", "b"]);
    printed.length = 0;
    expect(call(["list"])).toBe(0);
    expect(JSON.parse(printed[0]).notes).toHaveLength(2);
    printed.length = 0;
    expect(call(["list", "--about", "waiting"])).toBe(0);
    expect(
      JSON.parse(printed[0]).notes.map((n: { text: string }) => n.text),
    ).toEqual(["b"]);
  });
});
