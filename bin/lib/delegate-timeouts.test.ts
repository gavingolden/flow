import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_TIMEOUT_DEFAULTS,
  SYNC_DELEGATE_CEILING,
  godurToSec,
  isGoDuration,
  resolveDelegateTimeout,
  type DelegateTimeoutSurface,
} from "./delegate-timeouts";
import type { ReadConfigFile } from "./models-config";

// Inject the config-read seam so the real ~/.flow/config.json is never
// touched. Mirrors delegate-models.test.ts's `reader` helper.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

const ALL_SURFACES = Object.keys(
  DELEGATE_TIMEOUT_DEFAULTS,
) as DelegateTimeoutSurface[];

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("isGoDuration", () => {
  it.each(["8m", "5m", "90s", "2m30s", "1.5h", "500ms", "10us", "10µs", "1ns"])(
    "accepts %s",
    (value) => {
      expect(isGoDuration(value)).toBe(true);
    },
  );

  it.each(["", "8", "m", "8mm", "8 m", "eight minutes", "-8m"])(
    "rejects %s",
    (value) => {
      expect(isGoDuration(value)).toBe(false);
    },
  );

  it("accepts trailing/leading whitespace around an otherwise valid duration", () => {
    expect(isGoDuration(" 8m ")).toBe(true);
  });
});

describe("godurToSec", () => {
  it("converts single-unit durations", () => {
    expect(godurToSec("8m")).toBe(480);
    expect(godurToSec("90s")).toBe(90);
    expect(godurToSec("1h")).toBe(3600);
  });

  it("converts compound durations", () => {
    expect(godurToSec("2m30s")).toBe(150);
  });

  it("converts sub-second units", () => {
    expect(godurToSec("500ms")).toBeCloseTo(0.5);
  });

  it("throws on an invalid duration", () => {
    expect(() => godurToSec("eight minutes")).toThrow(/invalid duration/);
    expect(() => godurToSec("")).toThrow(/invalid duration/);
  });
});

describe("resolveDelegateTimeout", () => {
  it("resolves the seeded default for every surface when the config file is absent", () => {
    for (const surface of ALL_SURFACES) {
      expect(resolveDelegateTimeout(surface, reader(undefined))).toBe(
        DELEGATE_TIMEOUT_DEFAULTS[surface],
      );
    }
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("resolves the default silently on malformed/non-object JSON", () => {
    expect(resolveDelegateTimeout("reviewLens", reader("not-an-object"))).toBe(
      DELEGATE_TIMEOUT_DEFAULTS.reviewLens,
    );
    expect(resolveDelegateTimeout("reviewLens", reader(null))).toBe(
      DELEGATE_TIMEOUT_DEFAULTS.reviewLens,
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("resolves the default when delegate.timeouts key is absent", () => {
    expect(
      resolveDelegateTimeout(
        "intentGuess",
        reader({ delegate: { timeouts: {} } }),
      ),
    ).toBe(DELEGATE_TIMEOUT_DEFAULTS.intentGuess);
    expect(
      resolveDelegateTimeout("intentGuess", reader({ delegate: {} })),
    ).toBe(DELEGATE_TIMEOUT_DEFAULTS.intentGuess);
    expect(resolveDelegateTimeout("intentGuess", reader({}))).toBe(
      DELEGATE_TIMEOUT_DEFAULTS.intentGuess,
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("a present well-typed override under the ceiling wins", () => {
    expect(
      resolveDelegateTimeout(
        "reviewLens",
        reader({ delegate: { timeouts: { reviewLens: "6m" } } }),
      ),
    ).toBe("6m");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain("config override active");
  });

  it("a present wrong-typed value (number) warns once and resolves the default", () => {
    expect(
      resolveDelegateTimeout(
        "intentGuess",
        reader({ delegate: { timeouts: { intentGuess: 42 } } }),
      ),
    ).toBe(DELEGATE_TIMEOUT_DEFAULTS.intentGuess);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain(
      "delegate.timeouts.intentGuess",
    );
  });

  it("a present invalid-grammar string warns once and resolves the default", () => {
    expect(
      resolveDelegateTimeout(
        "reviewLens",
        reader({ delegate: { timeouts: { reviewLens: "eight minutes" } } }),
      ),
    ).toBe(DELEGATE_TIMEOUT_DEFAULTS.reviewLens);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("warns and clamps to the sync ceiling when the override exceeds it", () => {
    expect(
      resolveDelegateTimeout(
        "reviewLens",
        reader({ delegate: { timeouts: { reviewLens: "20m" } } }),
      ),
    ).toBe(SYNC_DELEGATE_CEILING);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain("sync ceiling");
  });

  // The remaining specs need a fresh module instance per test: only two
  // surfaces exist (reviewLens, intentGuess) and the warn-once sets are
  // module-scoped singletons, so re-using either surface's override/clamp
  // slot across tests above would silently record zero further calls — a
  // false pass, not a real assertion. vi.resetModules() + a fresh dynamic
  // import gives each of these its own singleton, mirroring
  // command-lint.test.ts's isolation pattern.
  it("an override exactly at the ceiling is accepted without a clamp warning", async () => {
    vi.resetModules();
    const fresh = await import("./delegate-timeouts");
    expect(
      fresh.resolveDelegateTimeout(
        "reviewLens",
        reader({
          delegate: { timeouts: { reviewLens: SYNC_DELEGATE_CEILING } },
        }),
      ),
    ).toBe(SYNC_DELEGATE_CEILING);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain("config override active");
  });

  it("the override-active notice fires once per surface per process, even across repeated calls", async () => {
    vi.resetModules();
    const fresh = await import("./delegate-timeouts");
    const cfg = reader({ delegate: { timeouts: { intentGuess: "6m" } } });
    fresh.resolveDelegateTimeout("intentGuess", cfg);
    fresh.resolveDelegateTimeout("intentGuess", cfg);
    fresh.resolveDelegateTimeout("intentGuess", cfg);
    const overrideCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("config override active"),
    );
    expect(overrideCalls.length).toBe(1);
  });

  it("the clamp notice fires once per surface per process, even across repeated calls", async () => {
    vi.resetModules();
    const fresh = await import("./delegate-timeouts");
    const cfg = reader({ delegate: { timeouts: { intentGuess: "20m" } } });
    fresh.resolveDelegateTimeout("intentGuess", cfg);
    fresh.resolveDelegateTimeout("intentGuess", cfg);
    const clampCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("sync ceiling"),
    );
    expect(clampCalls.length).toBe(1);
  });
});
