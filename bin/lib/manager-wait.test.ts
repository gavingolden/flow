import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateInScope, type ScopeFile } from "./manager-scope";
import type { ManagerLogEntry } from "./manager-log";
import {
  diffSnapshot,
  readSeen,
  RULING_PICKUP_MS,
  unpickedRulings,
  writeSeen,
  type SeenStore,
} from "./manager-wait";
import type { PipelineState } from "./state";

const T0 = "2026-11-12T00:00:00.000Z";
const NOW = new Date("2026-11-12T01:00:00.000Z");
const scope: ScopeFile = {
  version: 1,
  scopes: ["repo:flow"],
  updatedAt: T0,
  source: "owner-words",
};
const st = (over: Partial<PipelineState> = {}): PipelineState => ({
  slug: "a",
  phase: "implementing",
  repo: "/r/flow",
  updatedAt: T0,
  phaseLog: [{ phase: "implementing", at: T0 }],
  ...over,
});
const other = (over: Partial<PipelineState> = {}) =>
  st({ slug: "o", repo: "/r/other", ...over });
const opts = (s: ScopeFile | null = scope) => ({
  inScope: (p: PipelineState) => stateInScope(p, s),
  scope: s,
});
const kinds = (r: { events: { kind: string }[] }) =>
  r.events.map((e) => e.kind);
const baseline = (states: PipelineState[], s: ScopeFile | null = scope) =>
  diffSnapshot(null, states, NOW, opts(s)).next;

describe("diffSnapshot", () => {
  it("baselines silently, then never re-fires an already-gated pipeline", () => {
    const gated = st({
      phase: "gated",
      phaseLog: [{ phase: "gated", at: T0 }],
    });
    const first = diffSnapshot(null, [gated], NOW, opts());
    expect(first.events).toEqual([]);
    expect(kinds(diffSnapshot(first.next, [gated], NOW, opts()))).toEqual([]);
  });

  it("wakes on a transition into a wake phase and stays silent on CI phases", () => {
    const seen = baseline([st()]);
    const ci = st({
      phase: "ci-waiting",
      phaseLog: [{ phase: "ci-waiting", at: T0 }],
    });
    expect(kinds(diffSnapshot(seen, [ci], NOW, opts()))).toEqual([]);
    const gated = st({
      phase: "gated",
      phaseLog: [{ phase: "gated", at: T0 }],
    });
    const r = diffSnapshot(seen, [gated], NOW, opts());
    expect(r.events).toEqual([
      {
        kind: "transition",
        slug: "a",
        repo: "flow",
        from: "implementing",
        to: "gated",
      },
    ]);
  });

  it("wakes when the same wake phase is re-entered", () => {
    const g1 = st({ phase: "gated", phaseLog: [{ phase: "gated", at: T0 }] });
    const seen = baseline([g1]);
    const g2 = st({
      phase: "gated",
      phaseLog: [
        { phase: "gated", at: T0 },
        { phase: "gated", at: "2026-11-12T00:30:00.000Z" },
      ],
    });
    expect(kinds(diffSnapshot(seen, [g2], NOW, opts()))).toEqual([
      "transition",
    ]);
  });

  it("finds a new state file after the baseline without a restart", () => {
    const seen = baseline([st()]);
    const r = diffSnapshot(seen, [st(), st({ slug: "b" })], NOW, opts());
    expect(r.events).toEqual([
      { kind: "new", slug: "b", repo: "flow", to: "implementing" },
    ]);
  });

  it("reports gone only after two consecutive missing polls", () => {
    const seen = baseline([st()]);
    const one = diffSnapshot(seen, [], NOW, opts());
    expect(one.events).toEqual([]);
    const two = diffSnapshot(one.next, [], NOW, opts());
    expect(two.events).toEqual([
      { kind: "gone", slug: "a", repo: "flow", from: "implementing" },
    ]);
    expect(two.next.pipelines.a).toBeUndefined();
    const back = diffSnapshot(one.next, [st()], NOW, opts());
    expect(back.next.pipelines.a.missingPolls).toBeUndefined();
  });

  it("proposes a stale pipeline exactly once", () => {
    const old = st({
      updatedAt: "2026-11-01T00:00:00.000Z",
      phaseLog: [{ phase: "implementing", at: "2026-11-01T00:00:00.000Z" }],
    });
    const seen = baseline([old]);
    const r = diffSnapshot(seen, [old], NOW, opts());
    expect(kinds(r)).toEqual(["stale"]);
    expect(r.next.pipelines.a.staleProposedAt).toBe(NOW.toISOString());
    expect(kinds(diffSnapshot(r.next, [old], NOW, opts()))).toEqual([]);
  });

  it("emits nothing for out-of-scope transitions, new files and stale pipelines", () => {
    const old = other({
      updatedAt: "2026-11-01T00:00:00.000Z",
      phaseLog: [{ phase: "implementing", at: "2026-11-01T00:00:00.000Z" }],
    });
    const seen = baseline([old]);
    const moved = {
      ...old,
      phase: "gated",
      phaseLog: [{ phase: "gated", at: T0 }],
    };
    expect(diffSnapshot(seen, [moved], NOW, opts()).events).toEqual([]);
    expect(
      diffSnapshot(seen, [old, other({ slug: "p" })], NOW, opts()).events,
    ).toEqual([]);
    const next = diffSnapshot(seen, [moved], NOW, opts()).next;
    expect(next.pipelines.o.phase).toBe("gated");
  });

  it("still emits for an in-scope pipeline that just merged", () => {
    const seen = baseline([
      st({ phase: "merging", phaseLog: [{ phase: "merging", at: T0 }] }),
    ]);
    const merged = st({
      phase: "merged",
      phaseLog: [{ phase: "merged", at: T0 }],
    });
    expect(kinds(diffSnapshot(seen, [merged], NOW, opts()))).toEqual([
      "transition",
    ]);
  });

  it("emits scope-changed for a cli change only", () => {
    const seen = baseline([st()]);
    const cli: ScopeFile = {
      ...scope,
      source: "cli",
      updatedAt: "2026-11-12T00:50:00.000Z",
    };
    expect(kinds(diffSnapshot(seen, [st()], NOW, opts(cli)))).toEqual([
      "scope-changed",
    ]);
    const words: ScopeFile = { ...cli, source: "owner-words" };
    expect(kinds(diffSnapshot(seen, [st()], NOW, opts(words)))).toEqual([]);
  });

  it("emits a names-only new-candidate for an out-of-scope pipeline only while a focus note exists", () => {
    const seen = baseline([st()]);
    const focused: ScopeFile = {
      ...scope,
      focus: [{ id: "f1", text: "x", at: T0, from: "launch" }],
    };
    const o = other({ epic: { slug: "ep", featureId: "f" } });
    expect(diffSnapshot(seen, [st(), o], NOW, opts(focused)).events).toEqual([
      { kind: "new-candidate", slug: "o", repo: "other", epic: "ep" },
    ]);
    expect(diffSnapshot(seen, [st(), o], NOW, opts()).events).toEqual([]);
  });

  it("emits checkpoint-idle once per phase entry after 10 minutes, and no transition for entering it", () => {
    const seen = baseline([st()]);
    const pending = st({
      phase: "checkpoint-pending-clear",
      phaseLog: [
        { phase: "checkpoint-pending-clear", at: "2026-11-12T00:55:00.000Z" },
      ],
    });
    const early = diffSnapshot(seen, [pending], NOW, opts());
    expect(kinds(early)).toEqual([]);
    const later = new Date("2026-11-12T01:06:00.000Z");
    const r = diffSnapshot(early.next, [pending], later, opts());
    expect(kinds(r)).toEqual(["checkpoint-idle"]);
    expect(kinds(diffSnapshot(r.next, [pending], later, opts()))).toEqual([]);
  });

  it("emits idle only under stopWhenIdle when every in-scope pipeline waits on the owner or is finished", () => {
    const gated = st({
      phase: "gated",
      phaseLog: [{ phase: "gated", at: T0 }],
    });
    const seen = baseline([gated]);
    expect(kinds(diffSnapshot(seen, [gated], NOW, opts()))).toEqual([]);
    const idle = diffSnapshot(seen, [gated], NOW, {
      ...opts(),
      stopWhenIdle: true,
    });
    expect(kinds(idle)).toEqual(["idle"]);
    const busy = diffSnapshot(seen, [gated, st({ slug: "b" })], NOW, {
      ...opts(),
      stopWhenIdle: true,
    });
    expect(kinds(busy)).not.toContain("idle");
  });
});

describe("idle with an empty scope", () => {
  const idleOpts = (s: ScopeFile | null) => ({
    ...opts(s),
    stopWhenIdle: true,
  });

  it("never fires when the scope has no entries or matches no pipeline", () => {
    const empty: ScopeFile = { ...scope, scopes: [] };
    const gated = st({
      phase: "gated",
      phaseLog: [{ phase: "gated", at: T0 }],
    });
    for (const sc of [empty, { ...scope, scopes: ["repo:nothing"] }]) {
      const seen = baseline([gated], sc);
      expect(kinds(diffSnapshot(seen, [gated], NOW, idleOpts(sc)))).toEqual([]);
      expect(kinds(diffSnapshot(seen, [], NOW, idleOpts(sc)))).toEqual([]);
    }
  });

  it("still fires once every pipeline the scope covered has finished and its state is gone", () => {
    const gated = st({
      phase: "gated",
      phaseLog: [{ phase: "gated", at: T0 }],
    });
    const seen = baseline([gated]);
    expect(kinds(diffSnapshot(seen, [], NOW, idleOpts(scope)))).toContain(
      "idle",
    );
  });
});

describe("unaccepted rulings", () => {
  const WRITTEN = "2026-11-12T00:30:00.000Z";
  const paused = (over: Partial<PipelineState> = {}) =>
    st({
      phase: "plan-pending-review",
      phaseLog: [{ phase: "plan-pending-review", at: T0 }],
      ...over,
    });
  const written = (
    id = "r-1",
    over: Partial<ManagerLogEntry> = {},
  ): ManagerLogEntry => ({
    ts: WRITTEN,
    kind: "ruling-written",
    repo: "flow",
    slug: "a",
    phase: "plan-pending-review",
    key: `ruling:${id}`,
    ...over,
  });
  const accepted = (id = "r-1"): ManagerLogEntry => ({
    ...written(id),
    kind: "ruling-accepted",
  });
  const at = (ms: number) => new Date(Date.parse(WRITTEN) + ms);

  it("is quiet before 15 minutes and lists the ruling after", () => {
    expect(
      unpickedRulings([written()], [paused()], at(RULING_PICKUP_MS - 1)),
    ).toEqual([]);
    expect(
      unpickedRulings([written()], [paused()], at(RULING_PICKUP_MS)),
    ).toEqual([{ id: "r-1", slug: "a" }]);
  });

  it("drops an accepted ruling, a moved-on pipeline and a re-entered phase", () => {
    const later = at(RULING_PICKUP_MS);
    expect(unpickedRulings([written(), accepted()], [paused()], later)).toEqual(
      [],
    );
    expect(
      unpickedRulings([written()], [st({ phase: "implementing" })], later),
    ).toEqual([]);
    expect(
      unpickedRulings(
        [written()],
        [
          paused({
            phaseLog: [
              { phase: "plan-pending-review", at: "2026-11-12T00:45:00.000Z" },
            ],
          }),
        ],
        at(60 * 60_000),
      ),
    ).toEqual([]);
  });

  it("emits one ruling-unpicked event per ruling id for an in-scope pipeline, never twice", () => {
    const states = [paused()];
    const seen = baseline(states);
    const unpicked = [{ id: "r-1", slug: "a" }];
    const first = diffSnapshot(seen, states, NOW, { ...opts(), unpicked });
    expect(first.events).toEqual([
      { kind: "ruling-unpicked", slug: "a", repo: "flow", ruling: "r-1" },
    ]);
    expect(first.next.rulingsFired).toEqual(["r-1"]);
    const again = diffSnapshot(first.next, states, NOW, {
      ...opts(),
      unpicked,
    });
    expect(again.events).toEqual([]);
    const gone = diffSnapshot(first.next, states, NOW, opts());
    expect(gone.next.rulingsFired).toBeUndefined();
  });

  it("stays silent for an out-of-scope pipeline and on the baseline pass", () => {
    const out = other({
      phase: "plan-pending-review",
      phaseLog: [{ phase: "plan-pending-review", at: T0 }],
    });
    const seen = baseline([out]);
    expect(
      diffSnapshot(seen, [out], NOW, {
        ...opts(),
        unpicked: [{ id: "r-9", slug: "o" }],
      }).events,
    ).toEqual([]);
    const base = diffSnapshot(null, [paused()], NOW, {
      ...opts(),
      unpicked: [{ id: "r-1", slug: "a" }],
    });
    expect(base.events).toEqual([]);
    expect(base.next.rulingsFired).toEqual(["r-1"]);
  });
});

describe("seen store", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mwait-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("round-trips and reads a malformed file as null", () => {
    expect(readSeen(home)).toBeNull();
    const store: SeenStore = { version: 1, baselinedAt: T0, pipelines: {} };
    writeSeen(store, home);
    expect(readSeen(home)).toEqual(store);
    fs.writeFileSync(path.join(home, "waiter-seen.json"), "{nope");
    expect(readSeen(home)).toBeNull();
  });
});
