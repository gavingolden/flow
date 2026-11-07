import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCorrection,
  CHARTER_CHAR_LIMIT,
  extractCharterSection,
  readCharter,
  stripCharterSection,
} from "./exec-charter";
import { resolveProductBrief } from "../flow-product-brief";

let home: string;
const brief = () => path.join(home, ".flow", "product.md");
const write = (t: string) => {
  fs.mkdirSync(path.dirname(brief()), { recursive: true });
  fs.writeFileSync(brief(), t);
};

const CHARTER = `## Deciding on my behalf

1. point

### Standing corrections
`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "excharter-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("readCharter", () => {
  it("reads the raw section from the user-level brief", () => {
    write(`# Brief\n\n## Other\n\nx\n\n${CHARTER}\n## Vocabulary\n\nv\n`);
    const c = readCharter({ homeDir: home });
    expect(c.found).toBe(true);
    if (c.found) {
      expect(c.text.startsWith("## Deciding on my behalf")).toBe(true);
      expect(c.text).toContain("### Standing corrections");
      expect(c.text).not.toContain("Vocabulary");
      expect(c.path).toBe(brief());
    }
  });

  it("always reads the user-level file even when a repo brief exists", () => {
    write(`# user\n\n${CHARTER}`);
    const repo = path.join(home, "repo");
    fs.mkdirSync(path.join(repo, ".flow"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".flow", "product.md"), "# repo brief\n");
    const viaBriefReader = resolveProductBrief({
      cwd: repo,
      homeDir: home,
      repoRoot: () => repo,
    });
    expect(viaBriefReader.found && viaBriefReader.scope).toBe("repo");
    expect(readCharter({ homeDir: home }).found).toBe(true);
  });

  it("reports missing, too-long, and unreadable", () => {
    expect(readCharter({ homeDir: home })).toMatchObject({
      found: false,
      reason: "unreadable",
    });
    write("# no charter\n");
    expect(readCharter({ homeDir: home })).toMatchObject({
      found: false,
      reason: "missing",
    });
    write(`${CHARTER}${"x".repeat(CHARTER_CHAR_LIMIT)}\n`);
    expect(readCharter({ homeDir: home })).toMatchObject({
      found: false,
      reason: "too-long",
    });
  });
});

describe("strip / extract", () => {
  it("strips only the charter section and keeps neighbours", () => {
    const text = `# B\n\n## A\n\na\n\n${CHARTER}\n## Z\n\nz\n`;
    const out = stripCharterSection(text);
    expect(out).toContain("## A");
    expect(out).toContain("## Z");
    expect(out).not.toContain("Deciding on my behalf");
    expect(extractCharterSection(text)).not.toContain("## Z");
  });

  it("is a no-op without the heading", () => {
    expect(stripCharterSection("# B\n\n## A\n")).toBe("# B\n\n## A\n");
  });
});

describe("addCorrection", () => {
  const today = () => "2026-10-26";

  it("appends a dated bullet under Standing corrections", () => {
    write(`# B\n\n${CHARTER}\n## Z\n\nz\n`);
    const r = addCorrection("Never approve a plan that adds a config key", {
      homeDir: home,
      today,
    });
    expect(r).toEqual({ ok: true, path: brief() });
    const text = fs.readFileSync(brief(), "utf8");
    expect(text).toContain(
      "### Standing corrections\n\n- 2026-10-26: Never approve a plan that adds a config key\n",
    );
    expect(text).toContain("\n## Z\n\nz\n");
    expect((readCharter({ homeDir: home }) as { text: string }).text).toContain(
      "Never approve a plan",
    );
  });

  it("appends after existing bullets and records a decision id", () => {
    write(`${CHARTER}\n- 2026-10-01: old\n`);
    addCorrection("new  one\nsecond line", {
      homeDir: home,
      today,
      decisionId: "plan-1",
    });
    const text = fs.readFileSync(brief(), "utf8");
    expect(text).toContain(
      "- 2026-10-01: old\n- 2026-10-26: new one second line (decision plan-1)\n",
    );
  });

  it("creates the sub-heading when absent", () => {
    write("## Deciding on my behalf\n\n1. p\n\n## Z\n\nz\n");
    expect(addCorrection("c", { homeDir: home, today }).ok).toBe(true);
    const text = fs.readFileSync(brief(), "utf8");
    expect(text).toContain("### Standing corrections\n\n- 2026-10-26: c\n");
    expect(text.indexOf("Standing corrections")).toBeLessThan(
      text.indexOf("## Z"),
    );
  });

  it("refuses when the section is missing or the line is empty, and writes nothing", () => {
    write("# no charter\n");
    expect(addCorrection("c", { homeDir: home, today })).toEqual({
      ok: false,
      reason: "section-missing",
    });
    expect(fs.readFileSync(brief(), "utf8")).toBe("# no charter\n");
    expect(addCorrection("   ", { homeDir: home, today })).toEqual({
      ok: false,
      reason: "empty-line",
    });
  });

  it("reports write-failed when the brief does not exist", () => {
    expect(addCorrection("c", { homeDir: home, today })).toEqual({
      ok: false,
      reason: "write-failed",
    });
  });
});
