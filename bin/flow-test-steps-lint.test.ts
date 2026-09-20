import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./flow-test-steps-lint";

function bodyFile(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-test-steps-lint-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, body);
  return file;
}

function capture(argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err += String(c);
    return true;
  });
  const code = run(argv);
  o.mockRestore();
  e.mockRestore();
  return { code, out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("parseArgs", () => {
  it("defaults the phase to authoring", () => {
    expect(parseArgs(["--body-file", "b.md"])).toEqual({
      bodyFile: "b.md",
      phase: "authoring",
    });
  });

  it.each([
    [[], "--body-file is required"],
    [["--body-file"], "--body-file requires a value"],
    [["--body-file", "b.md", "--phase", "gate"], "--phase must be"],
    [["--nope", "x"], "unknown flag: --nope"],
  ])("rejects %j", (argv, msg) => {
    const r = parseArgs(argv as string[]);
    expect("error" in r && r.error).toContain(msg);
  });
});

describe("run", () => {
  it("exits 2 with usage on bad args and on an unreadable file", () => {
    expect(capture(["--phase", "review"])).toMatchObject({ code: 2, out: "" });
    const r = capture(["--body-file", "/nonexistent/body.md"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot read");
  });

  it("exits 0 and prints findings as JSON even when there are findings", () => {
    const file = bodyFile(
      "## Test Steps\n\n- [ ] Run `npm run verify` — green.\n- [ ] SUBJECTIVE: looks right.\n",
    );
    const r = capture(["--body-file", file, "--phase", "review"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({ headingPresent: true, phase: "review" });
    expect(json.steps).toHaveLength(2);
    expect(json.findings.map((f: { code: string }) => f.code)).toEqual([
      "generic-suite",
      "subjective-no-image",
    ]);
    expect(Object.keys(json.findings[0]).sort()).toEqual([
      "code",
      "hint",
      "line",
      "severity",
      "text",
    ]);
  });

  it("exits 0 with headingPresent false when the section is absent", () => {
    const r = capture(["--body-file", bodyFile("## Why\n\nnone\n")]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      headingPresent: false,
      steps: [],
      findings: [],
    });
  });
});
