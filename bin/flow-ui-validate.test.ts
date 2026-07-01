import { describe, expect, it } from "vitest";
import { isUiFile, parseArgs, run, type Deps } from "./flow-ui-validate";

// --- DI harness ------------------------------------------------------------

type Captured = { out: string; err: string; code: number };

function drive(
  argv: string[],
  files: Record<string, string>,
  extra: Partial<Deps> = {},
): Captured {
  let out = "";
  let err = "";
  const deps: Deps = {
    writeOut: (s) => {
      out += s;
    },
    writeErr: (s) => {
      err += s;
    },
    readFile: (p) => (p in files ? files[p] : null),
    fileExists: (p) => p in files,
    ...extra,
  };
  const code = run(argv, deps);
  return { out, err, code };
}

function envelope(c: Captured): Record<string, unknown> {
  return JSON.parse(c.out.trim());
}

const VALID_MANIFEST = JSON.stringify({
  launch: "npm run dev",
  baseUrl: "http://localhost:5173",
  loginUrl: "/login",
  credentialEnvVars: { user: "TEST_USER_EMAIL", pass: "TEST_USER_PASSWORD" },
  env: { PORT: "5273", VITE_API_URL: "http://localhost:8090" },
  routes: [
    { path: "/", expectSelectors: ["main"] },
    { path: "/dashboard", expectSelectors: ['[data-testid="dashboard"]'] },
  ],
  disableAnimations: true,
});

const MANIFEST_NO_ENV = JSON.stringify({
  launch: "npm run dev",
  baseUrl: "http://localhost:5173",
  routes: [{ path: "/" }],
});

const MANIFEST_PATH = ".flow/ui-validation.json";

// --- arg parsing -----------------------------------------------------------

describe("parseArgs", () => {
  it("defaults manifest, mcpAbsent, and browserBusy", () => {
    expect(parseArgs([])).toEqual({
      manifest: ".flow/ui-validation.json",
      mcpAbsent: false,
      browserBusy: false,
    });
  });

  it("--browser-busy sets browserBusy true", () => {
    const parsed = parseArgs(["--browser-busy"]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed) && !("help" in parsed)) {
      expect(parsed.browserBusy).toBe(true);
    }
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });

  it("accepts both --mcp-absent and --captures (mcp-absent wins downstream)", () => {
    const parsed = parseArgs(["--mcp-absent", "--captures", "c.json"]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed) && !("help" in parsed)) {
      expect(parsed.mcpAbsent).toBe(true);
      expect(parsed.captures).toBe("c.json");
    }
  });
});

describe("isUiFile signal", () => {
  it.each([
    "src/routes/+page.svelte",
    "src/app.css",
    "styles/main.scss",
    "src/lib/components/Button.svelte",
    "app/components/Nav.tsx",
    "app/page.tsx",
    "components/Foo.jsx",
    "src/App.vue",
  ])("treats '%s' as a UI file", (p) => {
    expect(isUiFile(p)).toBe(true);
  });

  it.each(["bin/flow-pre-commit.ts", "README.md", "src/lib/util.ts"])(
    "treats '%s' as a non-UI file",
    (p) => {
      expect(isUiFile(p)).toBe(false);
    },
  );
});

// --- Story 1: skip matrix --------------------------------------------------

describe("SKIP-DECISION — conditionally-loud matrix (Story 1)", () => {
  it("--mcp-absent → quiet mcp-not-available skip, exit 0", () => {
    const c = drive(["--mcp-absent"], {});
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(false);
    expect(e.skipped_reason).toBe("mcp-not-available");
  });

  it("--mcp-absent wins even when --captures is also given", () => {
    const c = drive(["--mcp-absent", "--captures", "c.json"], {});
    expect(envelope(c).skipped_reason).toBe("mcp-not-available");
  });

  it("--browser-busy → LOUD browser-profile-busy skip with nudge, exit 0", () => {
    const c = drive(["--browser-busy"], {});
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(true);
    expect(e.skipped_reason).toBe("browser-profile-busy");
    expect(typeof e.nudge).toBe("string");
    expect((e.nudge as string).length).toBeGreaterThan(0);
    expect(e.nudge).toContain("--isolated");
  });

  it("--mcp-absent wins over --browser-busy (gated first → quiet skip)", () => {
    const c = drive(["--mcp-absent", "--browser-busy"], {});
    const e = envelope(c);
    expect(e.skipped_reason).toBe("mcp-not-available");
    expect(e.loud).toBe(false);
  });

  it("--mcp-absent + UI diff + no manifest stays a quiet skip, never bootstraps", () => {
    // The bootstrap verdict's precondition is "MCP present", enforced only by
    // ordering: --mcp-absent returns early above the manifest===null branch.
    // Guard that a bootstrap-eligible UI diff under --mcp-absent still yields a
    // quiet mcp-not-available skip and leaks no inferred launch/route/cred
    // payload, so a future reorder of the early-return guard is caught.
    const c = drive(["--mcp-absent", "--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/about/+page.svelte\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      ".env.example": "TEST_USER_EMAIL=\nTEST_USER_PASSWORD=\n",
    });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(false);
    expect(e.skipped_reason).toBe("mcp-not-available");
    expect(e.action).toBeUndefined();
    expect(e.launch).toBeUndefined();
    expect(e.routes).toBeUndefined();
    expect(e.credentialEnvVars).toBeUndefined();
  });

  it("no manifest + UI-touching diff + MCP present → bootstrap verdict (Story 5)", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/about/+page.svelte\nsrc/lib/util.ts\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.action).toBe("bootstrap");
    expect(e.routes).toEqual(["/about"]);
    expect(e.launch).toBe("PORT={{PORT}} npm run dev");
    expect(e.baseUrl).toBe("http://localhost:{{PORT}}");
    // No skipped_reason on a bootstrap verdict — it's an action, not a skip.
    expect(e.skipped_reason).toBeUndefined();
  });

  it("bootstrap infers loginUrl + credential NAMES from routes + .env.example", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/login/+page.svelte\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      ".env.example": "TEST_USER_EMAIL=\nTEST_USER_PASSWORD=\n",
    });
    const e = envelope(c);
    expect(e.action).toBe("bootstrap");
    expect(e.loginUrl).toBe("/login");
    expect(e.credentialEnvVars).toEqual({
      user: "TEST_USER_EMAIL",
      pass: "TEST_USER_PASSWORD",
    });
    expect(e.needs).toEqual([]);
  });

  it("bootstrap needs 'launch' when no dev/start script exists", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/about/+page.svelte\n",
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });
    const e = envelope(c);
    expect(e.action).toBe("bootstrap");
    expect(e.launch).toBeUndefined();
    expect(e.needs).toContain("launch");
  });

  it("bootstrap needs 'routes' when a meaningful component diff derives no route", () => {
    // A bare component under lib/components is meaningful via isComponentOrPage
    // yet derives no URL (routeRootIndex returns -1), so the surface bootstraps
    // with routes:[] and needs:['routes'] — the one bootstrap-eligible-but-
    // routeless shape, previously unguarded.
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/lib/components/Button.svelte\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    const e = envelope(c);
    expect(e.action).toBe("bootstrap");
    expect(e.routes).toEqual([]);
    expect(e.needs).toContain("routes");
  });

  it("bootstrap needs 'credentials' when a login route exists but no creds are mined", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/login/+page.svelte\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    const e = envelope(c);
    expect(e.action).toBe("bootstrap");
    expect(e.loginUrl).toBe("/login");
    expect(e.credentialEnvVars).toBeUndefined();
    expect(e.needs).toContain("credentials");
  });

  it("GUARDRAIL: no populated .env VALUE leaks into the bootstrap envelope (Story 6)", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/login/+page.svelte\n",
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      ".env.example": "TEST_USER_EMAIL=\nTEST_USER_PASSWORD=\n",
      // A populated .env is injected via the readEnvExample dep to prove no
      // VALUE substring reaches the emitted JSON (helper reads names only).
    });
    // Drive readEnvExample with a POPULATED file to attempt a leak.
    const c2 = drive(
      ["--changed-files", "changed.txt"],
      { "changed.txt": "src/routes/login/+page.svelte\n" },
      {
        readPackageJson: () => JSON.stringify({ scripts: { dev: "vite" } }),
        readEnvExample: () =>
          "TEST_USER_EMAIL=alice@example.com\nTEST_USER_PASSWORD=hunter2-s3cret\n",
      },
    );
    for (const captured of [c, c2]) {
      expect(captured.out).not.toContain("alice@example.com");
      expect(captured.out).not.toContain("hunter2-s3cret");
    }
    const e2 = envelope(c2);
    expect(e2.credentialEnvVars).toEqual({
      user: "TEST_USER_EMAIL",
      pass: "TEST_USER_PASSWORD",
    });
  });

  it("bare .css change with no derivable route → quiet not-meaningful skip", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/app.css\n",
    });
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(false);
    expect(e.action).toBeUndefined();
    expect(e.skipped_reason).toBe("no-ui-manifest");
  });

  it("no manifest + non-UI diff → quiet no-ui-manifest", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "bin/flow-pre-commit.ts\nREADME.md\n",
    });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(false);
    expect(e.skipped_reason).toBe("no-ui-manifest");
  });

  it("malformed manifest degrades to no-ui-manifest with no throw", () => {
    const c = drive([], { [MANIFEST_PATH]: "{ not json" });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.skipped_reason).toBe("no-ui-manifest");
  });

  it("schema-invalid manifest (missing launch) degrades to no-ui-manifest", () => {
    const c = drive([], {
      [MANIFEST_PATH]: JSON.stringify({ baseUrl: "x", routes: [] }),
    });
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.skipped_reason).toBe("no-ui-manifest");
  });

  it("reads changed files from stdin when --changed-files is absent (bootstrap)", () => {
    const c = drive([], {}, { readStdin: () => "src/routes/x.svelte\n" });
    const e = envelope(c);
    expect(e.loud).toBe(true);
    expect(e.action).toBe("bootstrap");
    expect(e.routes).toEqual(["/x"]);
  });

  it("valid manifest + MCP present → ready (ran:true) listing routes", () => {
    const c = drive([], { [MANIFEST_PATH]: VALID_MANIFEST });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(true);
    expect(e.loud).toBe(false);
    expect(Array.isArray(e.routes)).toBe(true);
    expect((e.routes as unknown[]).length).toBe(2);
    expect((e.meta as Record<string, unknown>).baseUrl).toBe(
      "http://localhost:5173",
    );
    expect((e.meta as Record<string, unknown>).env).toEqual({
      PORT: "5273",
      VITE_API_URL: "http://localhost:8090",
    });
  });

  it("ready envelope meta.env is {} when the manifest declares no env", () => {
    const c = drive([], { [MANIFEST_PATH]: MANIFEST_NO_ENV });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(true);
    expect((e.meta as Record<string, unknown>).env).toEqual({});
  });
});

// --- Multi-viewport: meta.viewports surfacing -------------------------------

describe("SKIP-DECISION — meta.viewports (multi-viewport)", () => {
  it("ready envelope carries the 5-entry default when the manifest omits viewports", () => {
    const c = drive([], { [MANIFEST_PATH]: MANIFEST_NO_ENV });
    const e = envelope(c);
    expect(e.ran).toBe(true);
    expect((e.meta as Record<string, unknown>).viewports).toEqual([
      { name: "xs", width: 320 },
      { name: "mobile", width: 390 },
      { name: "tablet", width: 768 },
      { name: "desktop", width: 1280 },
      { name: "wide", width: 1440 },
    ]);
  });

  it("ready envelope carries the declared viewport set verbatim when present", () => {
    const manifest = JSON.stringify({
      launch: "npm run dev",
      baseUrl: "http://localhost:5173",
      routes: [{ path: "/" }],
      viewports: [
        { name: "narrow", width: 360 },
        { name: "wide", width: 1600, height: 1200 },
      ],
    });
    const c = drive([], { [MANIFEST_PATH]: manifest });
    const e = envelope(c);
    expect((e.meta as Record<string, unknown>).viewports).toEqual([
      { name: "narrow", width: 360 },
      { name: "wide", width: 1600, height: 1200 },
    ]);
  });

  it("viewports default is ABSENT on the --mcp-absent skip envelope", () => {
    const c = drive(["--mcp-absent"], {});
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.meta).toBeUndefined();
  });

  it("viewports default is ABSENT on the --browser-busy skip envelope", () => {
    const c = drive(["--browser-busy"], {});
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.meta).toBeUndefined();
  });

  it("viewports default is ABSENT on the no-ui-manifest skip envelope", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/+page.svelte\n",
    });
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.meta).toBeUndefined();
  });
});

// --- Story 2: ASSEMBLE mode ------------------------------------------------

describe("ASSEMBLE — precondition failures are loud (Story 2)", () => {
  it("launchOk:false → app-launch-failed loud, exit 0", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": JSON.stringify({
        launchOk: false,
        loginOk: false,
        routes: [],
      }),
    });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(true);
    expect(e.skipped_reason).toBe("app-launch-failed");
    expect(e.nudge).toContain("npm run dev");
  });

  it("loginOk:false → login-failed loud, exit 0", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": JSON.stringify({
        launchOk: true,
        loginOk: false,
        routes: [],
      }),
    });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.skipped_reason).toBe("login-failed");
    expect(e.nudge).toContain("seeded test user");
  });
});

describe("ASSEMBLE — per-route findings (Story 2)", () => {
  function captures(routes: unknown[]): string {
    return JSON.stringify({ launchOk: true, loginOk: true, routes });
  }

  it("all-clean routes → ran:true ok:true", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "<main> hello",
          screenshotPath: ".flow-tmp/ui-evidence/0.png",
        },
        {
          path: "/dashboard",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: 'div [data-testid="dashboard"] body',
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ran).toBe(true);
    expect(e.ok).toBe(true);
    expect(e.evidence_paths).toEqual([".flow-tmp/ui-evidence/0.png"]);
  });

  it("a console error fails the route", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: ["Uncaught TypeError"],
          failedRequests: [],
          snapshotText: "<main>",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.ok).toBe(false);
    expect(route.consoleErrors).toEqual(["Uncaught TypeError"]);
  });

  it("a failed network request fails the route", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: ["GET /api/x 500"],
          snapshotText: "<main>",
        },
      ]),
    });
    expect(envelope(c).ok).toBe(false);
  });

  it("a missing expected selector fails the route", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "document body div span button",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.missingSelectors).toEqual(["main"]);
  });

  it("filters missing/empty screenshotPath out of evidence_paths", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "<main>",
          screenshotPath: ".flow-tmp/ui-evidence/0.png",
        },
        {
          path: "/empty",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "<main>",
          screenshotPath: "",
        },
        {
          path: "/missing",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "<main>",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.evidence_paths).toEqual([".flow-tmp/ui-evidence/0.png"]);
  });

  it("malformed --captures file → exit 2", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": "{ not json",
    });
    expect(c.code).toBe(2);
  });

  it("ignoreRequestPatterns suppresses a benign favicon 404 → ok:true", () => {
    const manifest = JSON.stringify({
      launch: "npm run dev",
      baseUrl: "http://localhost:5173",
      routes: [{ path: "/" }],
      ignoreRequestPatterns: ["/favicon.ico"],
    });
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: manifest,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: ["http://localhost:5173/favicon.ico 404"],
          snapshotText: "<main>",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(true);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.ok).toBe(true);
    expect(route.failedRequests).toEqual([]);
  });

  it("ignoreConsolePatterns suppresses a matching console error → ok:true", () => {
    const manifest = JSON.stringify({
      launch: "npm run dev",
      baseUrl: "http://localhost:5173",
      routes: [{ path: "/" }],
      ignoreConsolePatterns: ["Failed to load resource"],
    });
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: manifest,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: ["Failed to load resource: the server responded 404"],
          failedRequests: [],
          snapshotText: "<main>",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(true);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.consoleErrors).toEqual([]);
  });

  it("a non-matching failedRequest/consoleError still fails the route", () => {
    const manifest = JSON.stringify({
      launch: "npm run dev",
      baseUrl: "http://localhost:5173",
      routes: [{ path: "/" }],
      ignoreRequestPatterns: ["/favicon.ico"],
      ignoreConsolePatterns: ["Failed to load resource"],
    });
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: manifest,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: ["Uncaught TypeError"],
          failedRequests: ["http://localhost:5173/api/x 500"],
          snapshotText: "<main>",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.consoleErrors).toEqual(["Uncaught TypeError"]);
    expect(route.failedRequests).toEqual(["http://localhost:5173/api/x 500"]);
  });

  it("absent ignore patterns => the favicon failedRequest fails the route", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: ["http://localhost:5173/favicon.ico 404"],
          snapshotText: "<main>",
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.failedRequests).toEqual([
      "http://localhost:5173/favicon.ico 404",
    ]);
  });

  it("captures file that parses but lacks routes → exit 2", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": JSON.stringify({ launchOk: true, loginOk: true }),
    });
    expect(c.code).toBe(2);
    expect(c.err).toContain("unreadable or malformed");
  });
});

// --- Multi-viewport: per-viewport geometry assertions (ASSEMBLE) ------------

describe("ASSEMBLE — per-viewport geometry assertions (multi-viewport)", () => {
  function captures(routes: unknown[]): string {
    return JSON.stringify({ launchOk: true, loginOk: true, routes });
  }

  // A manifest with a declared selector so missing-at-breakpoint has a target.
  const MANIFEST_WITH_SELECTOR = JSON.stringify({
    launch: "npm run dev",
    baseUrl: "http://localhost:5173",
    routes: [{ path: "/", expectSelectors: ["main"] }],
  });

  it("all viewports clean → ran:true ok:true with per-viewport screenshots aggregated", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              name: "mobile",
              width: 390,
              snapshotText: "<main>",
              rootGap: { left: 8, right: 8 },
              scrollWidth: 390,
              clientWidth: 390,
              screenshotPath: ".flow-tmp/ui-evidence/0-mobile.png",
            },
            {
              name: "wide",
              width: 1440,
              snapshotText: "<main>",
              rootGap: { left: 460, right: 460 },
              scrollWidth: 1440,
              clientWidth: 1440,
              screenshotPath: ".flow-tmp/ui-evidence/0-wide.png",
            },
          ],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ran).toBe(true);
    expect(e.ok).toBe(true);
    expect(e.evidence_paths).toEqual([
      ".flow-tmp/ui-evidence/0-mobile.png",
      ".flow-tmp/ui-evidence/0-wide.png",
    ]);
  });

  it("off-center constrained column (asymmetric rootGap beyond tolerance) → ok:false naming the viewport", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              name: "wide",
              width: 1440,
              snapshotText: "<main>",
              // mimics the /account regression: 24px left, 584px+ right gap
              rootGap: { left: 24, right: 880 },
              scrollWidth: 1440,
              clientWidth: 1440,
            },
          ],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.ok).toBe(false);
    expect((route.geometryIssues as string[]).join(" ")).toContain("[wide]");
    expect((route.geometryIssues as string[]).join(" ")).toContain(
      "off-center",
    );
  });

  it("symmetric rootGap within tolerance does not flag off-center", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              name: "wide",
              width: 1440,
              snapshotText: "<main>",
              // 40px asymmetry < tolerance max(16, 0.05*1440=72)
              rootGap: { left: 440, right: 480 },
              scrollWidth: 1440,
              clientWidth: 1440,
            },
          ],
        },
      ]),
    });
    expect(envelope(c).ok).toBe(true);
  });

  it("horizontal overflow (scrollWidth > clientWidth) → ok:false naming the viewport", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              name: "xs",
              width: 320,
              snapshotText: "<main>",
              rootGap: { left: 8, right: 8 },
              scrollWidth: 412,
              clientWidth: 320,
            },
          ],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect((route.geometryIssues as string[]).join(" ")).toContain("[xs]");
    expect((route.geometryIssues as string[]).join(" ")).toContain("overflow");
  });

  it("missing-element-at-breakpoint (declared selector present at one viewport, absent at another) → ok:false", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              name: "mobile",
              width: 390,
              snapshotText: "div body span", // 'main' absent here
            },
            {
              name: "desktop",
              width: 1280,
              snapshotText: "<main> present",
            },
          ],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    const issues = (route.geometryIssues as string[]).join(" ");
    expect(issues).toContain("missing-at-breakpoint");
    expect(issues).toContain("main");
    expect(issues).toContain("mobile");
  });

  it("a selector absent at EVERY viewport surfaces as missingSelectors, not a breakpoint mismatch", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            { name: "mobile", width: 390, snapshotText: "div body" },
            { name: "desktop", width: 1280, snapshotText: "span button" },
          ],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.missingSelectors).toEqual(["[mobile] main", "[desktop] main"]);
    expect(route.geometryIssues).toEqual([]);
  });

  it("a console error at one viewport fails the route, naming that viewport", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              name: "tablet",
              width: 768,
              snapshotText: "<main>",
              consoleErrors: ["Uncaught TypeError"],
            },
          ],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(false);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    expect(route.consoleErrors).toEqual(["[tablet] Uncaught TypeError"]);
  });

  it("a viewport with no snapshotText does NOT spuriously flag declared selectors as missing", () => {
    // Regression guard: filterCapture coerces an undefined snapshotText to "",
    // so without the withSnapshot guard the missing-selector loop would report
    // every declared expectSelector as missing for a no-snapshot viewport.
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "",
          viewports: [
            {
              // captured console/network but NO snapshot — snapshotText omitted
              name: "mobile",
              width: 390,
              rootGap: { left: 8, right: 8 },
              scrollWidth: 390,
              clientWidth: 390,
            },
            {
              name: "desktop",
              width: 1280,
              snapshotText: "<main> present",
              rootGap: { left: 100, right: 100 },
              scrollWidth: 1280,
              clientWidth: 1280,
            },
          ],
        },
      ]),
    });
    const e = envelope(c);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    // 'main' is present at desktop and the no-snapshot viewport is skipped on
    // both axes, so nothing should flag as missing or breakpoint-mismatched.
    expect(route.missingSelectors).toEqual([]);
    expect(route.geometryIssues).toEqual([]);
    expect(e.ok).toBe(true);
  });

  it("off-center boundary at width 1440: asymmetry exactly 72 does NOT flag, 73 flags (strict > on max(16, 0.05*width))", () => {
    // At 1440, tolerance = max(16, 0.05*1440) = 72. The strict `>` means
    // exactly 72 must pass; 73 must flag. Pins the comparator direction so a
    // `>`→`>=` regression is caught.
    const atAsymmetry = (asym: number) =>
      drive(["--captures", "cap.json"], {
        [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
        "cap.json": captures([
          {
            path: "/",
            consoleErrors: [],
            failedRequests: [],
            snapshotText: "",
            viewports: [
              {
                name: "wide",
                width: 1440,
                snapshotText: "<main>",
                rootGap: { left: 0, right: asym },
                scrollWidth: 1440,
                clientWidth: 1440,
              },
            ],
          },
        ]),
      });
    expect(envelope(atAsymmetry(72)).ok).toBe(true);
    expect(envelope(atAsymmetry(73)).ok).toBe(false);
  });

  it("16px floor branch at narrow width 200: asymmetry 12 does NOT flag, 17 flags (floor wins over relative 10)", () => {
    // At width 200, 0.05*200 = 10, so the absolute 16px floor dominates
    // (tolerance = max(16, 10) = 16). Asymmetry 12 is over the relative band
    // but under the floor → must NOT flag; 17 is over the floor → must flag.
    // Exercises the floor branch so a floor-drop/lowering regression is caught.
    const atAsymmetry = (asym: number) =>
      drive(["--captures", "cap.json"], {
        [MANIFEST_PATH]: MANIFEST_WITH_SELECTOR,
        "cap.json": captures([
          {
            path: "/",
            consoleErrors: [],
            failedRequests: [],
            snapshotText: "",
            viewports: [
              {
                name: "narrow",
                width: 200,
                snapshotText: "<main>",
                rootGap: { left: 0, right: asym },
                scrollWidth: 200,
                clientWidth: 200,
              },
            ],
          },
        ]),
      });
    expect(envelope(atAsymmetry(12)).ok).toBe(true);
    expect(envelope(atAsymmetry(17)).ok).toBe(false);
  });

  it("an empty viewports[] falls through the legacy single-capture path", () => {
    const c = drive(["--captures", "cap.json"], {
      [MANIFEST_PATH]: VALID_MANIFEST,
      "cap.json": captures([
        {
          path: "/",
          consoleErrors: [],
          failedRequests: [],
          snapshotText: "<main>",
          screenshotPath: ".flow-tmp/ui-evidence/0.png",
          viewports: [],
        },
      ]),
    });
    const e = envelope(c);
    expect(e.ok).toBe(true);
    const route = (e.routes as Array<Record<string, unknown>>)[0];
    // legacy path emits no geometryIssues key
    expect(route.geometryIssues).toBeUndefined();
    expect(e.evidence_paths).toEqual([".flow-tmp/ui-evidence/0.png"]);
  });
});

describe("CLI arg errors", () => {
  it("--manifest with no value → exit 2", () => {
    const c = drive(["--manifest"], {});
    expect(c.code).toBe(2);
    expect(c.err).toContain("--manifest requires a value");
  });

  it("--help → exit 0 with help text", () => {
    const c = drive(["--help"], {});
    expect(c.code).toBe(0);
    expect(c.out).toContain("flow-ui-validate");
  });
});
