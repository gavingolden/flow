import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepRefusalEvidence, type RefusalCacheFs } from "./agy-refusal-cache";

let root: string;
let dir: string;
let promptPath: string;
let rawPath: string;

const realFs: RefusalCacheFs = {
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, c, mode) => fs.writeFileSync(p, c, { mode }),
  mkdirp: (d, mode) => void fs.mkdirSync(d, { recursive: true, mode }),
  listDir: (d) => fs.readdirSync(d),
  removeFile: (p) => fs.rmSync(p, { force: true }),
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-refusal-cache-"));
  dir = path.join(root, "agy-refusals");
  promptPath = path.join(root, "lens.prompt");
  rawPath = path.join(root, "lens.raw");
  fs.writeFileSync(promptPath, "the prompt");
  fs.writeFileSync(rawPath, "the raw output");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const keep = (now: Date, extra: { keep?: number } = {}) =>
  keepRefusalEvidence(
    { dir, lens: "bug-detection", promptPath, rawPath, now, ...extra },
    realFs,
  );

describe("keepRefusalEvidence", () => {
  it("copies prompt and raw under a timestamp-sanitized name with private modes", () => {
    keep(new Date("2026-10-29T20:40:04.438Z"));

    const stem = "2026-10-29T20-40-04-438Z-bug-detection";
    expect(fs.readdirSync(dir).sort()).toEqual([
      `${stem}.prompt`,
      `${stem}.raw`,
    ]);
    expect(fs.readFileSync(path.join(dir, `${stem}.prompt`), "utf8")).toBe(
      "the prompt",
    );
    expect(fs.readFileSync(path.join(dir, `${stem}.raw`), "utf8")).toBe(
      "the raw output",
    );
    expect(fs.statSync(path.join(dir, `${stem}.prompt`)).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("copies what exists when the raw file is missing", () => {
    fs.rmSync(rawPath);
    keep(new Date("2026-10-29T20:40:04.438Z"));

    expect(fs.readdirSync(dir)).toEqual([
      "2026-10-29T20-40-04-438Z-bug-detection.prompt",
    ]);
  });

  it("prunes to the newest 20 pairs", () => {
    for (let i = 0; i < 22; i++) {
      keep(new Date(Date.UTC(2026, 9, 29, 0, i)));
    }

    const names = fs.readdirSync(dir).sort();
    expect(names).toHaveLength(40);
    expect(names[0]).toContain("2026-10-29T00-02-00");
    expect(names[names.length - 1]).toContain("2026-10-29T00-21-00");
  });

  it("leaves unrelated files in the directory alone", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
    keep(new Date("2026-10-29T20:40:04.438Z"), { keep: 1 });

    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("swallows a throwing writeFile", () => {
    const failing: RefusalCacheFs = {
      ...realFs,
      writeFile: () => {
        throw new Error("disk full");
      },
    };

    expect(() =>
      keepRefusalEvidence(
        { dir, lens: "bug-detection", promptPath, rawPath, now: new Date() },
        failing,
      ),
    ).not.toThrow();
  });
});
