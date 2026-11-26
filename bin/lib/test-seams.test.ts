import { afterEach, describe, expect, it } from "vitest";
import {
  UnstubbedSeamError,
  assertNoUnstubbedSeamHits,
  expectUnstubbedSeam,
  pickSeams,
  strictDeps,
  takeUnstubbedSeamHits,
} from "./test-seams";

type Deps = {
  read: (p: string) => string;
  write: (p: string) => void;
  dir: string;
};
const real = (): Deps => ({
  read: () => "real",
  write: () => {},
  dir: "/real",
});

afterEach(() => {
  takeUnstubbedSeamHits();
});

describe("strictDeps", () => {
  it("passes overrides through", () => {
    const d = strictDeps(real(), {
      read: () => "fake",
      write: () => {},
      dir: "/x",
    });
    expect(d.read("a")).toBe("fake");
    expect(d.dir).toBe("/x");
  });

  it("throws UnstubbedSeamError naming an un-stubbed function seam and records a hit", () => {
    const d = strictDeps(real(), { read: () => "fake", dir: "/x" });
    let err: unknown;
    try {
      d.write("/wt/file");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnstubbedSeamError);
    expect((err as UnstubbedSeamError).seam).toBe("write");
    expect((err as Error).message).toContain(
      'pickSeams(realDeps(), ["write"])',
    );
    expect(takeUnstubbedSeamHits()).toEqual(['write("/wt/file")']);
  });

  it("throws at build time for an un-overridden non-function seam", () => {
    expect(() =>
      strictDeps(real(), { read: () => "fake", write: () => {} }),
    ).toThrow(UnstubbedSeamError);
  });
});

describe("pickSeams", () => {
  it("picks only the named keys", () => {
    const picked = pickSeams(real(), ["read"]);
    expect(Object.keys(picked)).toEqual(["read"]);
    expect(picked.read("x")).toBe("real");
  });
});

describe("hit tracking", () => {
  it("takeUnstubbedSeamHits returns and clears", () => {
    const d = strictDeps(real(), { dir: "/x" });
    expect(() => d.read("a")).toThrow();
    expect(takeUnstubbedSeamHits()).toEqual(['read("a")']);
    expect(takeUnstubbedSeamHits()).toEqual([]);
  });

  it("assertNoUnstubbedSeamHits throws when hits are pending, then clears", () => {
    const d = strictDeps(real(), { dir: "/x" });
    expect(() => d.read("a")).toThrow();
    expect(() => assertNoUnstubbedSeamHits()).toThrow(/read\("a"\)/);
    expect(() => assertNoUnstubbedSeamHits()).not.toThrow();
  });
});

describe("expectUnstubbedSeam", () => {
  it("passes when fn throws for the seam", async () => {
    const d = strictDeps(real(), { dir: "/x" });
    await expectUnstubbedSeam(() => d.read("a"), "read");
  });

  it("passes when the hit was swallowed, and drains only that seam", async () => {
    const d = strictDeps(real(), { dir: "/x" });
    await expectUnstubbedSeam(() => {
      try {
        d.read("a");
      } catch {
        // swallowed
      }
    }, "read");
    expect(takeUnstubbedSeamHits()).toEqual([]);
    expect(() => d.write("b")).toThrow();
    await expectUnstubbedSeam(() => {}, "write");
  });

  it("fails when nothing hit the seam", async () => {
    await expect(expectUnstubbedSeam(() => {}, "read")).rejects.toThrow(
      /expected an unstubbed "read"/,
    );
  });

  it("fails on an unrelated error and keeps other seams' hits", async () => {
    const d = strictDeps(real(), { dir: "/x" });
    expect(() => d.write("w")).toThrow();
    await expect(
      expectUnstubbedSeam(() => {
        throw new Error("boom");
      }, "read"),
    ).rejects.toThrow(/boom/);
    expect(takeUnstubbedSeamHits()).toEqual(['write("w")']);
  });
});
