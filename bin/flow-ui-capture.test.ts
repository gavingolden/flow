import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { run, type Deps } from "./flow-ui-capture";
import { PLAYWRIGHT_MISSING_HINT } from "./lib/playwright-resolve";
import { validateUiDriverResult } from "./lib/ui-driver-schema";
import { buildCaptureScript } from "./lib/ui-capture-script";

const W = "/wt";
const OK_PW = {
  status: "ok",
  modulePath: "/wt/node_modules/playwright/index.js",
  hint: null,
} as const;
const MANIFEST = `${W}/.flow/ui-validation.json`;
const TARGETS = [{ route: "/analysis/AVGO", state: "empty", source: "plan" }];
const SHOT = `${W}/.flow-tmp/ui-evidence/critique/analysis-AVGO-1-phone.png`;
const NODE_OK = {
  ok: true,
  shots: [
    {
      route: "/analysis/AVGO",
      section: "Header",
      viewport: "phone",
      part: "whole",
      path: SHOT,
    },
  ],
  snapshots: [
    {
      route: "/analysis/AVGO",
      path: `${W}/.flow-tmp/ui-evidence/critique/analysis-AVGO.snapshot.txt`,
    },
  ],
  omittedSections: 0,
};

type Harness = {
  files: Map<string, string>;
  out: string[];
  err: string[];
  ran: { script: string; env: Record<string, string>; cwd: string }[];
  removed: string[];
  deps: Deps;
};

function harness(
  seed: Record<string, unknown> = {},
  over: Partial<Deps> = {},
  node: () => { exitCode: number; stdout: string } = () => ({
    exitCode: 0,
    stdout: JSON.stringify(NODE_OK) + "\n",
  }),
): Harness {
  const files = new Map<string, string>(
    Object.entries({ "/t.json": TARGETS, ...seed }).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  const h: Harness = {
    files,
    out: [],
    err: [],
    ran: [],
    removed: [],
    deps: undefined as unknown as Deps,
  };
  h.deps = {
    resolvePlaywright: () => OK_PW,
    runNode: (script, env, cwd) => {
      h.ran.push({ script, env, cwd });
      return node();
    },
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    mkdirp: () => {},
    mkdtemp: (parent) => `${parent}/run-1`,
    removeDir: (d) => void h.removed.push(d),
    gitHead: () => "head1",
    resolveTestAccount: () => ({ ok: false, reason: "manifest-not-committed" }),
    writeOut: (l) => void h.out.push(l),
    writeErr: (l) => void h.err.push(l),
    ...over,
  };
  return h;
}

const ARGS = [
  "--worktree",
  W,
  "--targets",
  "/t.json",
  "--base-url",
  "http://localhost:5173",
  "--out",
  "/out.json",
];
const result = (h: Harness) => JSON.parse(h.out[h.out.length - 1]);

describe("flow-ui-capture — skips", () => {
  it("prints playwright-unavailable and exits 0 when the repo has no Playwright", () => {
    const h = harness(
      {},
      {
        resolvePlaywright: () => ({
          status: "missing",
          modulePath: null,
          hint: PLAYWRIGHT_MISSING_HINT,
        }),
      },
    );
    expect(run(ARGS, h.deps)).toBe(0);
    expect(result(h)).toEqual({
      ran: false,
      skipReason: "playwright-unavailable",
      hint: PLAYWRIGHT_MISSING_HINT,
    });
    expect(h.ran).toEqual([]);
  });

  it("prints playwright-browsers-missing with the install hint", () => {
    const h = harness(
      {},
      {
        resolvePlaywright: () => ({
          status: "browsers-missing",
          modulePath: "/p",
          hint: "npx playwright install chromium",
        }),
      },
    );
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "playwright-browsers-missing",
      hint: "npx playwright install chromium",
    });
  });

  it("refuses a non-loopback base url before anything runs", () => {
    const h = harness();
    run(
      [
        "--worktree",
        W,
        "--targets",
        "/t.json",
        "--base-url",
        "https://app.example.com",
        "--out",
        "/o.json",
      ],
      h.deps,
    );
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "non-local-base-url",
    });
    expect(h.ran).toEqual([]);
  });

  it("skips with no-targets for an empty or unreadable targets file", () => {
    for (const seed of [{ "/t.json": [] }, { "/t.json": "not json" }]) {
      const h = harness(seed);
      run(ARGS, h.deps);
      expect(result(h)).toMatchObject({ ran: false, skipReason: "no-targets" });
    }
  });

  it("exits 2 on bad arguments", () => {
    const h = harness();
    expect(run(["--worktree", W], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("--targets is required");
    expect(run(["--bogus", "x"], h.deps)).toBe(2);
  });
});

describe("flow-ui-capture — probe", () => {
  it("prints the Playwright status and captures nothing", () => {
    const h = harness();
    expect(run(["--probe", "--worktree", W], h.deps)).toBe(0);
    expect(result(h)).toEqual(OK_PW);
    expect(h.ran).toEqual([]);
  });
});

describe("flow-ui-capture — capture", () => {
  it("writes a driver-schema artifact with the shots and snapshots, then cleans up", () => {
    const h = harness();
    expect(run(ARGS, h.deps)).toBe(0);
    expect(result(h)).toMatchObject({ ran: true, out: "/out.json", shots: 1 });
    const artifact = JSON.parse(h.files.get("/out.json")!);
    expect(validateUiDriverResult(artifact).ok).toBe(true);
    expect(artifact).toMatchObject({
      caller: "verify",
      headSha: "head1",
      ran: true,
      ok: true,
    });
    expect(artifact.section_shots).toHaveLength(1);
    expect(artifact.route_snapshots).toHaveLength(1);
    expect(h.removed).toEqual([`${W}/.flow-tmp/ui-capture/run-1`]);
  });

  it("runs the script from the worktree against the resolved absolute module path, with no login", () => {
    const h = harness();
    run(ARGS, h.deps);
    const script = h.files.get(`${W}/.flow-tmp/ui-capture/run-1/capture.cjs`)!;
    expect(script).toContain(JSON.stringify(OK_PW.modulePath));
    expect(h.ran[0].cwd).toBe(W);
    expect(h.ran[0].env.FLOW_CAPTURE_USER).toBeUndefined();
    const cfg = JSON.parse(
      h.files.get(`${W}/.flow-tmp/ui-capture/run-1/config.json`)!,
    );
    expect(cfg.login).toBeNull();
    expect(cfg.names["/analysis/AVGO|1|phone|whole"]).toBe(SHOT);
    expect(cfg.viewportsLight.map((v: { name: string }) => v.name)).toEqual([
      "phone",
      "desktop",
    ]);
    expect(cfg.viewportsDark).toHaveLength(4);
  });

  it("a node script that fails or prints garbage is capture-failed", () => {
    const h = harness({}, {}, () => ({ exitCode: 1, stdout: "boom" }));
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "capture-failed",
    });
    expect(h.files.has("/out.json")).toBe(false);
    expect(h.removed).toHaveLength(1);
  });

  it("maps a login-failed script result to the login-failed skip", () => {
    const h = harness({}, {}, () => ({
      exitCode: 0,
      stdout:
        JSON.stringify({
          ok: false,
          error: "login-failed",
          detail: "still on the login page",
        }) + "\n",
    }));
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({ ran: false, skipReason: "login-failed" });
  });
});

describe("flow-ui-capture — test-account login", () => {
  const LOGIN_MANIFEST = {
    [MANIFEST]: {
      baseUrl: "http://localhost:5173",
      loginUrl: "/login",
      credentialEnvVars: { user: "U", pass: "P" },
    },
  };
  const account = {
    ok: true as const,
    values: { user: "u@x", pass: "pw-9f3" },
    baseUrl: "http://localhost:5173",
  };

  it("passes credentials only through the child's env and never to disk, stdout or the artifact", () => {
    const h = harness(LOGIN_MANIFEST, { resolveTestAccount: () => account });
    run(ARGS, h.deps);
    expect(h.ran[0].env).toMatchObject({
      FLOW_CAPTURE_USER: "u@x",
      FLOW_CAPTURE_PASS: "pw-9f3",
    });
    const cfg = JSON.parse(
      h.files.get(`${W}/.flow-tmp/ui-capture/run-1/config.json`)!,
    );
    expect(cfg.login).toEqual({ url: "http://localhost:5173/login" });
    const persisted = [...h.files.values(), ...h.out, ...h.err].join("\n");
    expect(persisted).not.toContain("pw-9f3");
    expect(persisted).not.toContain("u@x");
  });

  it("applies the account guards before any value is resolved and passes their refusal through", () => {
    const h = harness(LOGIN_MANIFEST, {
      resolveTestAccount: () => ({
        ok: false,
        reason: "manifest-not-committed",
      }),
    });
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "manifest-not-committed",
    });
    expect(h.ran).toEqual([]);
  });

  it("reports missing credentials as credentials-unavailable", () => {
    const h = harness(LOGIN_MANIFEST, {
      resolveTestAccount: () => ({ ok: false, reason: "credentials-missing" }),
    });
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "credentials-unavailable",
    });
  });

  it("refuses a login url that leaves the loopback host without resolving credentials", () => {
    let resolved = false;
    const h = harness(
      {
        [MANIFEST]: {
          loginUrl: "https://evil.example.com/login",
          credentialEnvVars: { user: "U", pass: "P" },
        },
      },
      { resolveTestAccount: () => ((resolved = true), account) },
    );
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({
      ran: false,
      skipReason: "non-local-base-url",
    });
    expect(resolved).toBe(false);
  });

  it("needs no account when the manifest declares no login", () => {
    const h = harness({ [MANIFEST]: { baseUrl: "http://localhost:5173" } });
    run(ARGS, h.deps);
    expect(result(h)).toMatchObject({ ran: true });
  });
});

describe("generated capture script", () => {
  it("is syntactically valid node", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-capture-script-"));
    try {
      const file = path.join(dir, "capture.cjs");
      fs.writeFileSync(file, buildCaptureScript("/x/playwright/index.js"));
      const r = spawnSync("node", ["--check", file], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never screenshots before login completes and reads credentials only from env", () => {
    const script = buildCaptureScript("/x/p.js");
    expect(script).toContain("process.env.FLOW_CAPTURE_PASS");
    const loginFn = script.slice(
      script.indexOf("async function login"),
      script.indexOf("async function open"),
    );
    expect(loginFn).not.toContain("screenshot");
    expect(loginFn).not.toContain("trace");
    expect(script).not.toContain("recordVideo");
    expect(script).not.toContain("recordHar");
  });
});
