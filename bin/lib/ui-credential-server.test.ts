import { describe, expect, it } from "vitest";
import * as http from "node:http";
import { originsMatch, startCredentialServer } from "./ui-credential-server";

describe("originsMatch", () => {
  it.each([
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:5173", "http://localhost:5173"],
    ["http://localhost:5173", "http://127.0.0.1:5173"],
    ["http://[::1]:5173", "http://localhost:5173"],
  ])("accepts %s against allowed %s", (requestOrigin, allowedOrigin) => {
    expect(originsMatch(requestOrigin, allowedOrigin)).toBe(true);
  });

  it.each([
    ["http://localhost:3000", "http://localhost:5173"],
    ["https://localhost:5173", "http://localhost:5173"],
    ["http://evil.example", "http://localhost:5173"],
    ["not a url", "http://localhost:5173"],
    ["http://localhost:5173", "not a url"],
  ])("rejects %s against allowed %s", (requestOrigin, allowedOrigin) => {
    expect(originsMatch(requestOrigin, allowedOrigin)).toBe(false);
  });
});

function get(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startCredentialServer OPTIONS preflight", () => {
  it("204s an OPTIONS request from the allowed origin", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      token: "tok",
      origin: "http://localhost:5173",
    });
    try {
      const res = await get(`http://127.0.0.1:${handle.port}/tok`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
    } finally {
      handle.stop();
    }
  });

  it("403s an OPTIONS request from a disallowed origin", async () => {
    const handle = await startCredentialServer({
      values: { user: "u", pass: "p" },
      token: "tok",
      origin: "http://localhost:5173",
    });
    try {
      const res = await get(`http://127.0.0.1:${handle.port}/tok`, {
        method: "OPTIONS",
        headers: { Origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
    } finally {
      handle.stop();
    }
  });
});
