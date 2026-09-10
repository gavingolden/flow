import { describe, expect, it } from "vitest";
import {
  collectLaunchConfigWarnings,
  LAUNCH_CONFIG_KEYS,
  readLaunchDefaults,
  type ReadConfigFile,
} from "./launch-config";

// Inject the config-read seam so the real ~/.flow/config.json is never touched.
// Mirrors models-config.test.ts's `reader` helper.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readLaunchDefaults", () => {
  it("reads back each of the five valid launch keys", () => {
    const cfg = reader({
      launch: {
        effort: "high",
        autoMerge: true,
        waitForCopilot: false,
        forceResearch: true,
        interviewMode: "skip",
      },
    });
    expect(readLaunchDefaults(cfg)).toEqual({
      effort: "high",
      autoMerge: true,
      waitForCopilot: false,
      forceResearch: true,
      interviewMode: "skip",
    });
  });

  it("returns {} and no warning when the config file is absent", () => {
    expect(readLaunchDefaults(reader(undefined))).toEqual({});
    expect(collectLaunchConfigWarnings(reader(undefined))).toEqual([]);
  });

  it("returns {} and [] warnings for a malformed/non-object config", () => {
    expect(readLaunchDefaults(reader("nope"))).toEqual({});
    expect(collectLaunchConfigWarnings(reader("nope"))).toEqual([]);
    expect(readLaunchDefaults(reader(42))).toEqual({});
    expect(collectLaunchConfigWarnings(reader(42))).toEqual([]);
  });

  it("collapses a non-object or array `launch` value to {} plus exactly one warning", () => {
    expect(readLaunchDefaults(reader({ launch: "nope" }))).toEqual({});
    expect(
      collectLaunchConfigWarnings(reader({ launch: "nope" })),
    ).toHaveLength(1);

    expect(readLaunchDefaults(reader({ launch: [1, 2] }))).toEqual({});
    expect(
      collectLaunchConfigWarnings(reader({ launch: [1, 2] })),
    ).toHaveLength(1);

    expect(readLaunchDefaults(reader({ launch: null }))).toEqual({});
  });

  it.each(["false", "no", 0, [], null])(
    "rejects truthy-but-not-boolean autoMerge value %j (no truthiness coercion)",
    (value) => {
      const cfg = reader({ launch: { autoMerge: value } });
      expect(readLaunchDefaults(cfg).autoMerge).toBeUndefined();
      if (value !== null) {
        expect(
          collectLaunchConfigWarnings(cfg).some((w) =>
            w.includes("launch.autoMerge"),
          ),
        ).toBe(true);
      }
    },
  );

  it("rejects an out-of-enum effort and accepts a valid one", () => {
    expect(
      readLaunchDefaults(reader({ launch: { effort: "extreme" } })).effort,
    ).toBeUndefined();
    expect(
      collectLaunchConfigWarnings(
        reader({ launch: { effort: "extreme" } }),
      ).some((w) => w.includes("launch.effort")),
    ).toBe(true);
    expect(
      readLaunchDefaults(reader({ launch: { effort: "high" } })).effort,
    ).toBe("high");
  });

  it("rejects an invalid interviewMode and accepts force/skip", () => {
    expect(
      readLaunchDefaults(reader({ launch: { interviewMode: "maybe" } }))
        .interviewMode,
    ).toBeUndefined();
    expect(
      readLaunchDefaults(reader({ launch: { interviewMode: "force" } }))
        .interviewMode,
    ).toBe("force");
    expect(
      readLaunchDefaults(reader({ launch: { interviewMode: "skip" } }))
        .interviewMode,
    ).toBe("skip");
  });

  it("emits the legacy interview.enabled migration warning", () => {
    const warnings = collectLaunchConfigWarnings(
      reader({ interview: { enabled: false } }),
    );
    expect(
      warnings.some(
        (w) =>
          w.includes("interview.enabled") && w.includes("launch.interviewMode"),
      ),
    ).toBe(true);
  });

  it("calls the injected read exactly once even with all five keys present", () => {
    let calls = 0;
    const read: ReadConfigFile = () => {
      calls += 1;
      return {
        launch: {
          effort: "high",
          autoMerge: true,
          waitForCopilot: true,
          forceResearch: true,
          interviewMode: "skip",
        },
      };
    };
    readLaunchDefaults(read);
    expect(calls).toBe(1);
  });

  it("returns {} rather than propagating when read() throws", () => {
    const read: ReadConfigFile = () => {
      throw new Error("boom");
    };
    expect(readLaunchDefaults(read)).toEqual({});
    expect(collectLaunchConfigWarnings(read)).toEqual([]);
  });

  it("LAUNCH_CONFIG_KEYS has one row per LaunchDefaults key", () => {
    expect(LAUNCH_CONFIG_KEYS.map((e) => e.key).sort()).toEqual(
      [
        "autoMerge",
        "effort",
        "forceResearch",
        "interviewMode",
        "waitForCopilot",
      ].sort(),
    );
  });
});
