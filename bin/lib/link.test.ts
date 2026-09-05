/**
 * Tests for the TTY-gated clickable-target helper. Harness copied from
 * `bin/lib/color.test.ts:29-40` — `isTTY` is redefined via
 * `Object.defineProperty` (a plain assignment throws, `isTTY` has no
 * setter on the real stream), and NO_COLOR/FLOW_NO_HYPERLINKS/FORCE_COLOR
 * are saved and restored around each test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyLinkModeOptOut,
  fileUri,
  hyperlinksEnabled,
  linkLabel,
  linkPath,
  linkUrl,
  resolveLinkMode,
  visibleLength,
} from "./link";

let origIsTTY: boolean | undefined;
let origNoColor: string | undefined;
let origNoHyperlinks: string | undefined;
let origForceColor: string | undefined;

beforeEach(() => {
  origIsTTY = process.stdout.isTTY;
  origNoColor = process.env.NO_COLOR;
  origNoHyperlinks = process.env.FLOW_NO_HYPERLINKS;
  origForceColor = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  delete process.env.FLOW_NO_HYPERLINKS;
  delete process.env.FORCE_COLOR;
});

afterEach(() => {
  setIsTTY(origIsTTY);
  restoreEnv("NO_COLOR", origNoColor);
  restoreEnv("FLOW_NO_HYPERLINKS", origNoHyperlinks);
  restoreEnv("FORCE_COLOR", origForceColor);
});

function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("hyperlinksEnabled / resolveLinkMode", () => {
  it("is true only on a TTY with neither NO_COLOR nor FLOW_NO_HYPERLINKS", () => {
    setIsTTY(true);
    expect(hyperlinksEnabled()).toBe(true);
    expect(resolveLinkMode()).toBe("terminal");
  });

  it("is false when stdout is not a TTY", () => {
    setIsTTY(false);
    expect(hyperlinksEnabled()).toBe(false);
    expect(resolveLinkMode()).toBe("plain");
  });

  it("is false when NO_COLOR is set, even on a TTY", () => {
    setIsTTY(true);
    process.env.NO_COLOR = "1";
    expect(hyperlinksEnabled()).toBe(false);
  });

  it("is false when FLOW_NO_HYPERLINKS is set, even on a TTY", () => {
    setIsTTY(true);
    process.env.FLOW_NO_HYPERLINKS = "1";
    expect(hyperlinksEnabled()).toBe(false);
  });

  it("ignores FORCE_COLOR — a piped FORCE_COLOR=1 run stays link-free", () => {
    setIsTTY(undefined);
    process.env.FORCE_COLOR = "1";
    expect(hyperlinksEnabled()).toBe(false);
  });
});

describe("fileUri", () => {
  it("returns null for an empty or whitespace-only path", () => {
    expect(fileUri("")).toBeNull();
    expect(fileUri("   ")).toBeNull();
  });

  it("percent-encodes a path containing a space and yields the empty-host file:/// form", () => {
    const uri = fileUri("/tmp/a b/c.txt");
    expect(uri).not.toBeNull();
    expect(uri!.startsWith("file:///")).toBe(true);
    expect(uri).toContain("a%20b");
  });

  it("resolves a relative path rather than returning null", () => {
    const uri = fileUri("relative/path.md");
    expect(uri).not.toBeNull();
    expect(uri!.startsWith("file:///")).toBe(true);
    expect(uri).toContain("relative/path.md");
  });
});

describe("visibleLength", () => {
  it("ignores OSC 8 hyperlink escapes", () => {
    const wrapped = "\x1b]8;;file:///x\x1b\\label\x1b]8;;\x1b\\";
    expect(visibleLength(wrapped)).toBe("label".length);
  });

  it("ignores SGR escapes", () => {
    expect(visibleLength("\x1b[32mok\x1b[0m")).toBe("ok".length);
  });

  it("returns the plain length of a string with no escapes", () => {
    expect(visibleLength("plain")).toBe(5);
  });
});

describe("linkUrl / linkPath wrap modes", () => {
  it("terminal mode wraps with OSC 8", () => {
    expect(linkUrl("https://example.com/x", "terminal")).toBe(
      "\x1b]8;;https://example.com/x\x1b\\https://example.com/x\x1b]8;;\x1b\\",
    );
  });

  it("markdown mode wraps as a markdown link", () => {
    expect(linkUrl("https://example.com/x", "markdown")).toBe(
      "[https://example.com/x](https://example.com/x)",
    );
  });

  it("plain mode returns the label unchanged", () => {
    expect(linkUrl("https://example.com/x", "plain")).toBe(
      "https://example.com/x",
    );
  });

  it("linkUrl returns the label unchanged for a falsy url", () => {
    expect(linkUrl("", "terminal")).toBe("");
  });

  it("linkPath falls back to the bare label for an empty path", () => {
    expect(linkPath("", "terminal")).toBe("");
  });

  it("passes a label already containing an escape byte through unwrapped", () => {
    const label = "\x1b[32mgreen\x1b[0m";
    expect(linkUrl(label, "terminal")).toBe(label);
    expect(linkUrl(label, "markdown")).toBe(label);
  });
});

describe("linkLabel (named exception: label != raw target)", () => {
  it("wraps a short label around a different URI in terminal mode", () => {
    expect(
      linkLabel("#123", "https://github.com/org/repo/pull/123", "terminal"),
    ).toBe(
      "\x1b]8;;https://github.com/org/repo/pull/123\x1b\\#123\x1b]8;;\x1b\\",
    );
  });

  it("wraps a short label around a different URI in markdown mode", () => {
    expect(
      linkLabel("#123", "https://github.com/org/repo/pull/123", "markdown"),
    ).toBe("[#123](https://github.com/org/repo/pull/123)");
  });

  it("returns the bare label in plain mode", () => {
    expect(
      linkLabel("#123", "https://github.com/org/repo/pull/123", "plain"),
    ).toBe("#123");
  });

  it("falls back to the bare label for a falsy url", () => {
    expect(linkLabel("#123", "", "terminal")).toBe("#123");
  });
});

describe("wrap — URI-side hardening", () => {
  // linkLabel is the one export where label !== target, and its URI comes
  // from state.prUrl (validated only as `typeof === "string"`). Guarding
  // only the label would let a state-file value break out of the OSC 8
  // payload and inject terminal control codes.
  it("falls back to the bare label when the URI carries an ESC", () => {
    expect(linkLabel("#123", "https://x/\x1b]8;;evil\x1b\\", "terminal")).toBe(
      "#123",
    );
  });

  it("falls back to the bare label when the URI carries a BEL", () => {
    // BEL is a valid OSC terminator in xterm/iTerm2, so it escapes the
    // payload just as an ESC does.
    expect(linkLabel("#123", "https://x/\x07evil", "terminal")).toBe("#123");
  });

  it("falls back to the bare label when the URI carries a newline", () => {
    expect(linkLabel("#123", "https://x/a\nb", "terminal")).toBe("#123");
  });

  it("guards the URI in markdown mode too", () => {
    expect(linkLabel("#123", "https://x/\x1bevil", "markdown")).toBe("#123");
  });

  it("percent-encodes parens in a markdown link destination", () => {
    // A markdown link destination ends at the first unbalanced `)`, so a
    // raw paren silently truncates the target and desyncs it from the label.
    const out = linkPath("/tmp/My Project (old)/plan.md", "markdown");
    expect(out).toContain("%28");
    expect(out).toContain("%29");
    expect(out.endsWith(")")).toBe(true);
    expect(out).toBe(
      `[/tmp/My Project (old)/plan.md](${out.slice(out.indexOf("](") + 2, -1)})`,
    );
  });

  it("leaves parens alone in terminal mode (OSC 8 has no paren delimiter)", () => {
    const out = linkPath("/tmp/a (b)/p.md", "terminal");
    expect(out).toContain("(b)");
  });
});

describe("applyLinkModeOptOut", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("downgrades an explicit terminal mode when FLOW_NO_HYPERLINKS is set", () => {
    process.env.FLOW_NO_HYPERLINKS = "1";
    expect(applyLinkModeOptOut("terminal")).toBe("plain");
  });

  it("downgrades an explicit terminal mode when NO_COLOR is set", () => {
    process.env.NO_COLOR = "";
    expect(applyLinkModeOptOut("terminal")).toBe("plain");
  });

  it("leaves terminal mode alone when neither opt-out is set", () => {
    delete process.env.FLOW_NO_HYPERLINKS;
    delete process.env.NO_COLOR;
    expect(applyLinkModeOptOut("terminal")).toBe("terminal");
  });

  it("never downgrades markdown mode — it emits no escape bytes", () => {
    process.env.FLOW_NO_HYPERLINKS = "1";
    expect(applyLinkModeOptOut("markdown")).toBe("markdown");
  });
});
