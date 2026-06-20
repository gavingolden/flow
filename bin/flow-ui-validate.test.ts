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

  it("no manifest + UI-touching diff → LOUD no-ui-manifest with nudge", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": "src/routes/+page.svelte\nsrc/lib/util.ts\n",
    });
    expect(c.code).toBe(0);
    const e = envelope(c);
    expect(e.ran).toBe(false);
    expect(e.loud).toBe(true);
    expect(e.skipped_reason).toBe("no-ui-manifest");
    expect(e.nudge).toContain("templates/ui-validation.json.example");
    expect(e.nudge).toContain("src/routes/+page.svelte");
  });

  it("nudge lists at most 3 changed UI files", () => {
    const c = drive(["--changed-files", "changed.txt"], {
      "changed.txt": ["a.svelte", "b.svelte", "c.svelte", "d.svelte"].join(
        "\n",
      ),
    });
    const e = envelope(c);
    expect(e.nudge).toContain("a.svelte, b.svelte, c.svelte");
    expect(e.nudge).not.toContain("d.svelte");
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

  it("reads changed files from stdin when --changed-files is absent", () => {
    const c = drive([], {}, { readStdin: () => "src/routes/x.svelte\n" });
    const e = envelope(c);
    expect(e.loud).toBe(true);
    expect(e.skipped_reason).toBe("no-ui-manifest");
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
