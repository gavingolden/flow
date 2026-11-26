import { afterEach, describe, expect, it } from "vitest";
import {
  sectionScrollSource,
  type SectionScrollResult,
} from "./ui-section-scroll";

const W = 390;
const H = 844;

type Style = Partial<{
  position: string;
  visibility: string;
  opacity: string;
  overflowY: string;
}>;

type Spec = {
  parent: Node | null;
  style?: Style;
  /** Document-space top for in-flow nodes; viewport-space top for fixed/sticky. */
  top?: number;
  height?: number;
  width?: number;
  noRects?: boolean;
  closestHits?: string[];
};

class Node {
  kids: Node[] = [];
  constructor(
    public id: string,
    public spec: Spec,
    private root: { scrollTop: number },
  ) {
    spec.parent?.kids.push(this);
  }
  get parentElement(): Node | null {
    return this.spec.parent;
  }
  get pinned(): boolean {
    const p = this.spec.style?.position;
    return p === "fixed" || p === "sticky";
  }
  getClientRects(): unknown[] {
    return this.spec.noRects ? [] : [{}];
  }
  getBoundingClientRect() {
    const top = (this.spec.top ?? 0) - (this.pinned ? 0 : this.root.scrollTop);
    const height = this.spec.height ?? 0;
    return { top, bottom: top + height, height, width: this.spec.width ?? W };
  }
  contains(o: Node | null): boolean {
    for (let n: Node | null = o; n; n = n.parentElement)
      if (n === this) return true;
    return false;
  }
  closest(sel: string): Node | null {
    for (let n: Node | null = this; n; n = n.parentElement) {
      if (n.spec.closestHits?.includes(sel)) return n;
    }
    return null;
  }
}

type Fixture = {
  nodes: Node[];
  sections: Node[];
  bar: Node | null;
  root: {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    scrollBy: (o: { top: number }) => void;
  };
};

function build(opts: {
  heights: number[];
  padBottom?: number;
  bar?: Omit<Spec, "parent"> | "none";
  barInSection?: number;
  extra?: (f: Fixture, body: Node, sections: Node[]) => void;
  filler?: number;
}): Fixture {
  const padBottom = opts.padBottom ?? 65;
  const total = opts.heights.reduce((a, b) => a + b, 0) + padBottom;
  const root = {
    scrollTop: 0,
    clientHeight: H,
    scrollHeight: total,
    scrollBy({ top }: { top: number }) {
      const max = total - H;
      root.scrollTop = Math.min(max, Math.max(0, root.scrollTop + top));
    },
  };
  const html = new Node("html", { parent: null }, root);
  const body = new Node("body", { parent: html }, root);
  const main = new Node("main", { parent: body }, root);
  const nodes: Node[] = [html, body, main];
  const sections: Node[] = [];
  let y = 0;
  opts.heights.forEach((h, i) => {
    const s = new Node(`s${i}`, { parent: main, top: y, height: h }, root);
    sections.push(s);
    nodes.push(s);
    y += h;
  });
  for (let i = 0; i < (opts.filler ?? 0); i++) {
    nodes.push(new Node(`f${i}`, { parent: main, top: 0, height: 10 }, root));
  }
  const fx: Fixture = { nodes, sections, bar: null, root };
  if (opts.bar !== "none") {
    const barSpec = {
      style: { position: "fixed" },
      top: H - 57,
      height: 57,
      ...(opts.bar ?? {}),
    };
    const host =
      opts.barInSection === undefined ? body : sections[opts.barInSection];
    fx.bar = new Node("bar", { parent: host, ...barSpec }, root);
    nodes.push(fx.bar);
  }
  opts.extra?.(fx, body, sections);
  return fx;
}

const g = globalThis as Record<string, unknown>;
const saved = {
  document: g.document,
  window: g.window,
  getComputedStyle: g.getComputedStyle,
};
afterEach(() => Object.assign(g, saved));

function run(
  fx: Fixture,
  sel: string,
  part: "start" | "end",
): SectionScrollResult {
  const byId = new Map(fx.nodes.map((n) => [`#${n.id}`, n]));
  const [html, body] = fx.nodes;
  g.document = {
    body,
    documentElement: html,
    scrollingElement: fx.root,
    querySelector: (s: string) => byId.get(s) ?? null,
    querySelectorAll: () => fx.nodes,
  };
  g.window = { innerWidth: W, innerHeight: H };
  g.getComputedStyle = (n: Node) => ({
    position: "static",
    visibility: "visible",
    opacity: "1",
    overflowY: "visible",
    ...n.spec.style,
  });
  for (const s of fx.sections) {
    (s as unknown as Record<string, unknown>).scrollIntoView = ({
      block,
    }: {
      block: string;
    }) => {
      const top = s.spec.top ?? 0;
      const target = block === "end" ? top + (s.spec.height ?? 0) - H : top;
      fx.root.scrollTop = 0;
      fx.root.scrollBy({ top: target });
    };
  }
  const fn = new Function(`return ${sectionScrollSource()}`)() as (a: {
    sel: string;
    part: string;
  }) => SectionScrollResult;
  return fn({ sel, part });
}

describe("sectionScrollSource", () => {
  it("is a self-contained arrow function", () => {
    const src = sectionScrollSource();
    expect(src.startsWith("(a) =>")).toBe(true);
    expect(() => new Function(`return ${src}`)).not.toThrow();
  });

  it("reports found:false for a missing selector", () => {
    const fx = build({ heights: [1400] });
    expect(run(fx, "#nope", "end")).toEqual({
      found: false,
      offsetPx: 0,
      clippedByBottom: false,
    });
  });

  it("nudges an end shot above a fixed bottom bar", () => {
    const fx = build({ heights: [1400, 1400, 1400] });
    const r = run(fx, "#s2", "end");
    expect(r.offsetPx).toBe(57);
    const bottom = fx.sections[2].getBoundingClientRect().bottom;
    expect(bottom).toBeLessThanOrEqual(fx.bar!.getBoundingClientRect().top);
  });

  it("clamps at the document end when there is no room to nudge", () => {
    const fx = build({ heights: [1400, 1400, 1400], padBottom: 20 });
    const r = run(fx, "#s2", "end");
    expect(r.offsetPx).toBe(20);
    expect(fx.root.scrollTop).toBe(fx.root.scrollHeight - H);
    expect(fx.sections[2].getBoundingClientRect().bottom).toBeGreaterThan(
      fx.bar!.getBoundingClientRect().top,
    );
  });

  it("does not move when there is no chrome", () => {
    const fx = build({ heights: [1400, 1400], bar: "none" });
    expect(run(fx, "#s0", "end").offsetPx).toBe(0);
  });

  it.each<[string, Omit<Spec, "parent">]>([
    ["display:none bar", { noRects: true }],
    ["opacity:0 bar", { style: { position: "fixed", opacity: "0" } }],
    ["unpinned sticky element", { style: { position: "sticky" }, top: 300 }],
    ["400px fixed overlay", { top: H - 400, height: 400 }],
    ["aria-hidden bar", { closestHits: ['[aria-hidden="true"]'] }],
  ])("ignores a %s", (_n, bar) => {
    const fx = build({ heights: [1400, 1400], bar });
    expect(run(fx, "#s0", "end").offsetPx).toBe(0);
  });

  it("ignores a sticky heading inside the section", () => {
    const fx = build({
      heights: [1400, 1400],
      bar: "none",
      extra: (f, _b, sections) => {
        f.nodes.push(
          new Node(
            "h",
            {
              parent: sections[0],
              style: { position: "sticky" },
              top: 0,
              height: 40,
            },
            f.root,
          ),
        );
      },
    });
    expect(run(fx, "#s0", "start").offsetPx).toBe(0);
  });

  it("clears a pinned sticky top header on a start shot", () => {
    const fx = build({
      heights: [1400, 1400, 1400],
      bar: "none",
      extra: (f, body) => {
        f.nodes.push(
          new Node(
            "hdr",
            { parent: body, style: { position: "sticky" }, top: 0, height: 56 },
            f.root,
          ),
        );
      },
    });
    expect(run(fx, "#s1", "start").offsetPx).toBe(-56);
  });

  it("flags a start shot whose section runs under the bottom bar", () => {
    expect(
      run(build({ heights: [900, 900, 900] }), "#s1", "start").clippedByBottom,
    ).toBe(true);
    expect(
      run(build({ heights: [600, 600, 600] }), "#s1", "start").clippedByBottom,
    ).toBe(false);
  });

  it("counts a fixed bar that lives inside the section", () => {
    const fx = build({ heights: [1400, 1400, 1400], barInSection: 2 });
    expect(run(fx, "#s2", "end").offsetPx).toBe(57);
  });

  it("counts a bar inset 12px from the bottom", () => {
    const fx = build({
      heights: [1400, 1400, 1400],
      padBottom: 100,
      bar: { top: H - 12 - 57 },
    });
    expect(run(fx, "#s2", "end").offsetPx).toBe(57 + 12);
  });

  it("finds a bar placed after thousands of other nodes", () => {
    const fx = build({ heights: [1400, 1400, 1400], filler: 3500 });
    expect(run(fx, "#s2", "end").offsetPx).toBe(57);
  });
});
