import { describe, expect, it } from "vitest";
import type { GuardResult } from "./epic-manage-guard";
import {
  NOTIFY_PHASES,
  OWNER_NEEDED_PHASES,
  ownerNeededFor,
  renderManageBoard,
  type BoardModel,
} from "./epic-manage-board";
import type { EpicManifest, Feature } from "./epic-manifest-schema";
import { reconcile } from "./epic-reconcile";
import type { EpicRunState } from "./epic-run-state";
import type { PipelineState } from "./state";

const EPIC = "my-epic";

const feat = (
  id: string,
  dependsOn: string[] = [],
  waitFor?: string,
): Feature => ({
  id,
  title: id,
  description: id,
  dependsOn,
  ...(waitFor ? { waitFor } : {}),
});

const manifest = (...features: Feature[]): EpicManifest => ({
  epicId: EPIC,
  prompt: "p",
  createdAt: "2026-10-26",
  features,
});

const stateOf = (
  slug: string,
  phase: string,
  over: Partial<PipelineState> = {},
): PipelineState => ({
  slug,
  phase,
  repo: "/repo",
  updatedAt: "2026-10-26T00:00:00Z",
  ...over,
});

function reconciled(
  m: EpicManifest,
  bound: Record<string, string>,
  states: PipelineState[],
) {
  const runState: EpicRunState = {
    epicSlug: EPIC,
    repo: "/repo",
    manifestPath: "/repo/m.json",
    manifestSha: "s",
    createdAt: "t",
    updatedAt: "t",
    features: Object.fromEntries(
      Object.entries(bound).map(([id, slug]) => [
        id,
        { slug, launchedAt: "x" },
      ]),
    ),
  };
  return reconcile({
    manifest: m,
    runState,
    readFeatureState: (slug) => states.find((s) => s.slug === slug) ?? null,
    maxParallel: 3,
  });
}

const noGuard: GuardResult = {
  verdicts: [],
  globalDrift: [],
  boundDrift: [],
  observedMerged: [],
};

function model(over: Partial<BoardModel> = {}): BoardModel {
  const m = manifest(feat("alpha"), feat("beta", ["alpha"]));
  return {
    epicSlug: EPIC,
    result: reconciled(m, {}, []),
    manager: {
      model: "opus",
      effort: "high",
      autonomy: "observe",
      featureFallback: {},
    },
    headSha: "abc1234",
    notifyOn: true,
    ownerNeeded: [],
    guard: {
      ...noGuard,
      verdicts: [{ id: "alpha", action: "launch", overrides: {} }],
    },
    github: { ok: true, ageMs: 12_000 },
    updatedAt: "2026-10-26T12:00:00Z",
    final: false,
    ...over,
  };
}

describe("renderManageBoard snapshots", () => {
  it("idle: nothing launched, nothing needed", () => {
    expect(renderManageBoard(model())).toMatchSnapshot();
  });

  it("launching: one flow epic launch in flight", () => {
    const m = manifest(feat("alpha"), feat("beta"));
    expect(
      renderManageBoard(
        model({
          result: reconciled(m, {}, []),
          guard: {
            ...noGuard,
            verdicts: [
              { id: "alpha", action: "launching" },
              { id: "beta", action: "capacity" },
            ],
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("drift: bound and global drift name the pointer and the window", () => {
    const m = manifest(feat("alpha"), feat("beta"));
    expect(
      renderManageBoard(
        model({
          result: reconciled(m, { alpha: "alpha-old" }, []),
          guard: {
            verdicts: [
              {
                id: "beta",
                action: "drift",
                reason: "a merged PR #9 is on branch 'beta'",
              },
            ],
            globalDrift: [
              "run.json names 'ghost', which the manifest no longer has",
            ],
            boundDrift: [
              {
                id: "alpha",
                reason:
                  "run.json binds 'alpha' to 'alpha-old' but no pipeline state exists for it",
              },
            ],
            observedMerged: [],
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("waiting: a wait node shows waiting on: <waitFor>", () => {
    const m = manifest(
      feat("alpha"),
      feat("gate", [], "the rollout lands in prod"),
    );
    expect(
      renderManageBoard(
        model({
          result: reconciled(m, {}, []),
          guard: {
            ...noGuard,
            verdicts: [
              { id: "alpha", action: "launch", overrides: {} },
              {
                id: "gate",
                action: "waiting",
                waitFor: "the rollout lands in prod",
              },
            ],
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("owner-needed: names the window to answer in", () => {
    const m = manifest(feat("alpha"), feat("beta"));
    const states = [
      stateOf("alpha", "plan-pending-review", {
        phaseLog: [{ phase: "planning", at: "t" }],
      }),
      stateOf("beta", "gated", { pr: 41 }),
    ];
    const result = reconciled(m, { alpha: "alpha", beta: "beta" }, states);
    expect(
      renderManageBoard(
        model({
          result,
          ownerNeeded: ownerNeededFor(
            result.board,
            new Map(states.map((s) => [s.slug, s])),
          ),
          guard: noGuard,
          notifyOn: false,
        }),
      ),
    ).toMatchSnapshot();
  });

  it("GitHub unreachable and failed launch lines", () => {
    const m = manifest(feat("alpha"), feat("beta"));
    expect(
      renderManageBoard(
        model({
          result: reconciled(m, {}, []),
          github: { ok: false, ageMs: 400_000, error: "gh: HTTP 502" },
          guard: {
            ...noGuard,
            verdicts: [
              { id: "alpha", action: "github-unverified" },
              {
                id: "beta",
                action: "failed",
                reason: "flow feature create exited 1",
              },
            ],
          },
          manager: {
            model: "haiku",
            effort: "low",
            autonomy: "observe",
            featureFallback: { model: "haiku", effort: "low" },
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("final: every feature merged", () => {
    const m = manifest(feat("alpha"), feat("beta", ["alpha"]));
    const states = [stateOf("alpha", "merged"), stateOf("beta", "merged")];
    expect(
      renderManageBoard(
        model({
          result: reconciled(m, { alpha: "alpha", beta: "beta" }, states),
          guard: noGuard,
          final: true,
        }),
      ),
    ).toMatchSnapshot();
  });
});

describe("renderManageBoard slots", () => {
  it("header shows manager model/effort and the unhinted-features source", () => {
    expect(renderManageBoard(model())).toContain(
      "manager opus/high · unhinted features: config · autonomy observe · checkout abc1234",
    );
    expect(
      renderManageBoard(
        model({
          manager: {
            model: "haiku",
            effort: "low",
            autonomy: "observe",
            featureFallback: { model: "haiku", effort: "low" },
          },
        }),
      ),
    ).toContain("manager haiku/low · unhinted features: haiku/low");
  });

  it("flags notifications off only when FLOW_NOTIFY is not on", () => {
    expect(renderManageBoard(model({ notifyOn: false }))).toContain(
      "notifications off — set FLOW_NOTIFY=1",
    );
    expect(renderManageBoard(model({ notifyOn: true }))).not.toContain(
      "notifications off",
    );
  });

  it("ends with the Next action slot, last", () => {
    const lines = renderManageBoard(model()).split("\n");
    expect(lines.at(-1)).toMatch(/^\*\*Next action:\*\* /);
  });

  it("every drift, hold, and launch-failed line names the window and a reason", () => {
    const out = renderManageBoard(
      model({
        guard: {
          verdicts: [
            { id: "a1", action: "drift", reason: "R1" },
            { id: "a2", action: "failed", reason: "R2" },
            { id: "a3", action: "capacity" },
          ],
          globalDrift: [],
          boundDrift: [],
          observedMerged: [],
        },
      }),
    );
    for (const prefix of ["drift: a1", "launch failed: a2", "hold: a3"]) {
      const line = out.split("\n").find((l) => l.includes(prefix))!;
      expect(line).toContain(`(window manage-${EPIC})`);
    }
    expect(out).toContain("run /flow-epic-run reconcile-drift");
  });
});

describe("ownerNeededFor", () => {
  const m = manifest(feat("alpha"), feat("beta"), feat("gamma"), feat("delta"));

  it("lists owner-needed phases with window, reason, key, and per-phase notify flag", () => {
    const states = [
      stateOf("alpha", "plan-pending-review", {
        phaseLog: [
          { phase: "x", at: "t" },
          { phase: "y", at: "t" },
        ],
      }),
      stateOf("beta", "gated", { pr: 3 }),
      stateOf("gamma", "needs-human"),
      stateOf("delta", "implementing"),
    ];
    const result = reconciled(
      m,
      { alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta" },
      states,
    );
    const lines = ownerNeededFor(
      result.board,
      new Map(states.map((s) => [s.slug, s])),
    );
    expect(lines.map((l) => [l.id, l.phase, l.window, l.notify])).toEqual([
      ["alpha", "plan-pending-review", "alpha", true],
      ["beta", "gated", "beta", false],
      ["gamma", "needs-human", "gamma", false],
    ]);
    expect(lines[0]).toMatchObject({
      key: "alpha:plan-pending-review:2",
      reason: expect.any(String),
    });
    expect(lines[1]!.pr).toBe(3);
  });

  it("never notifies for the phases pipelines already announce", () => {
    for (const phase of ["gated", "needs-human", "browser-retry-pending"]) {
      expect(OWNER_NEEDED_PHASES.has(phase)).toBe(true);
      expect(NOTIFY_PHASES.has(phase)).toBe(false);
    }
    for (const phase of [
      "plan-pending-review",
      "plan-pending-interview",
      "triage-pending-interview",
      "triage-pending-clarification",
      "approval-pending-clarification",
      "checkpoint-pending-clear",
      "triaged-no-change",
    ]) {
      expect(NOTIFY_PHASES.has(phase)).toBe(true);
    }
    expect(OWNER_NEEDED_PHASES.has("ci-wait-pending")).toBe(false);
    expect(OWNER_NEEDED_PHASES.has("plan-review-pending")).toBe(false);
  });
});
