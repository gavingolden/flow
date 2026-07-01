import { describe, expect, it } from "vitest";
import {
  allocFreePort,
  inferLaunch,
  PORT_PLACEHOLDER,
  resolvePortPlaceholder,
} from "./ui-launch-infer";
import * as net from "node:net";

describe("inferLaunch — Story 3", () => {
  it("prefers scripts.dev over scripts.start", () => {
    const info = inferLaunch(
      JSON.stringify({ scripts: { dev: "vite", start: "node server" } }),
    );
    expect(info).not.toBeNull();
    expect(info!.launch).toContain("npm run dev");
    expect(info!.launch).not.toContain("npm run start");
  });

  it("falls back to scripts.start when dev is absent", () => {
    const info = inferLaunch(JSON.stringify({ scripts: { start: "node s" } }));
    expect(info!.launch).toContain("npm run start");
  });

  it("returns null when neither dev nor start exists", () => {
    expect(
      inferLaunch(JSON.stringify({ scripts: { build: "tsc" } })),
    ).toBeNull();
  });

  it("returns null when scripts is missing entirely", () => {
    expect(inferLaunch(JSON.stringify({ name: "x" }))).toBeNull();
  });

  it("returns null on malformed JSON without throwing", () => {
    expect(inferLaunch("{ not json")).toBeNull();
  });

  it("the persisted form carries the {{PORT}} placeholder, never a frozen port", () => {
    const info = inferLaunch(JSON.stringify({ scripts: { dev: "vite" } }))!;
    expect(info.launch).toContain(PORT_PLACEHOLDER);
    expect(info.baseUrl).toContain(PORT_PLACEHOLDER);
    // No frozen literal port digits leaked into the persisted form.
    expect(/:\d{2,5}/.test(info.baseUrl)).toBe(false);
    expect(info.baseUrl).toBe("http://localhost:{{PORT}}");
  });
});

describe("resolvePortPlaceholder", () => {
  it("literal-replaces every {{PORT}} occurrence", () => {
    expect(
      resolvePortPlaceholder("PORT={{PORT}} url=http://x:{{PORT}}", 4321),
    ).toBe("PORT=4321 url=http://x:4321");
  });

  it("is a no-op when no placeholder is present", () => {
    expect(resolvePortPlaceholder("npm run dev", 4321)).toBe("npm run dev");
  });
});

describe("allocFreePort", () => {
  it("returns a port in the ephemeral range", async () => {
    const port = await allocFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("returns a port that is actually bindable (free at check time)", async () => {
    const port = await allocFreePort();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  });
});
