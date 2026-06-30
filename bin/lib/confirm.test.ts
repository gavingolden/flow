import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs's readSync so the default stdin reader is fully controllable
// from tests. The real fs.readSync property isn't reconfigurable, so vi.spyOn
// fails — vi.mock at module scope is the only way in.
const readSyncMock = vi.hoisted(() =>
  vi.fn<(fd: number, buf: Buffer, ...rest: unknown[]) => number>(() => 0),
);
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readSync: readSyncMock };
});

import { confirmStdin } from "./confirm";

describe("confirmStdin (default stdin reader)", () => {
  beforeEach(() => {
    readSyncMock.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function feed(input: string) {
    readSyncMock.mockImplementation((_fd, buf: Buffer) => {
      const bytes = Buffer.from(input, "utf8");
      bytes.copy(buf);
      return bytes.length;
    });
  }

  it("returns true on 'y'", () => {
    feed("y\n");
    expect(confirmStdin("proceed?")).toBe(true);
  });

  it("returns true on 'yes'", () => {
    feed("yes\n");
    expect(confirmStdin("proceed?")).toBe(true);
  });

  it("returns false on 'n'", () => {
    feed("n\n");
    expect(confirmStdin("proceed?")).toBe(false);
  });

  it("returns false when the read throws (no TTY / closed fd-0)", () => {
    readSyncMock.mockImplementation(() => {
      throw new Error("EOF");
    });
    expect(confirmStdin("proceed?")).toBe(false);
  });

  it("writes the prompt to stdout", () => {
    feed("y\n");
    const write = vi.spyOn(process.stdout, "write");
    confirmStdin("remove it?");
    expect(write).toHaveBeenCalledWith("remove it? [y/N] ");
  });
});
