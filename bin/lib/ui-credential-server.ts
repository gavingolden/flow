/**
 * The one-time local HTTP endpoint `bin/flow-ui-login.ts serve`'s detached
 * child binds. It answers a single GET with the credential VALUES as JSON —
 * once, to the app's own origin, on a page-initiated `fetch` (never to a
 * bare `curl`) — then shuts itself down.
 *
 * `node:http`, not `Bun.serve`: this module is imported directly by
 * `bin/lib/ui-credential-server.test.ts` under vitest, which runs on Node,
 * not the Bun runtime (`Bun` is undefined there) — see `vitest.setup.ts`.
 *
 * Internal import of `bin/flow-ui-login.ts` only, NOT PATH-registered.
 */

import * as http from "node:http";

export type CredentialServerOpts = {
  values: { user: string; pass: string };
  token: string;
  origin: string;
  ttlMs?: number;
};

export type CredentialServerHandle = {
  port: number;
  closed: Promise<void>;
  stop: () => void;
};

export const DEFAULT_CREDENTIAL_SERVER_TTL_MS = 90_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseOrigin(
  origin: string,
): { scheme: string; host: string; port: string } | null {
  try {
    const u = new URL(origin);
    return {
      scheme: u.protocol,
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}

/**
 * Same-scheme, same-port loopback alias check: `localhost`, `127.0.0.1`
 * and `[::1]` are the same server from the app's point of view, so a
 * request whose `Origin` uses a different loopback spelling than `--origin`
 * still gets through. Any non-loopback host must match exactly.
 */
export function originsMatch(
  requestOrigin: string,
  allowedOrigin: string,
): boolean {
  if (requestOrigin === allowedOrigin) return true;
  const a = parseOrigin(requestOrigin);
  const b = parseOrigin(allowedOrigin);
  if (!a || !b) return false;
  if (a.scheme !== b.scheme || a.port !== b.port) return false;
  return LOOPBACK_HOSTS.has(a.host) && LOOPBACK_HOSTS.has(b.host);
}

export function startCredentialServer(
  opts: CredentialServerOpts,
): Promise<CredentialServerHandle> {
  const ttlMs = opts.ttlMs ?? DEFAULT_CREDENTIAL_SERVER_TTL_MS;
  let used = false;
  let stopped = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(ttlTimer);
    server.close(() => resolveClosed());
  }

  const server = http.createServer((req, res) => {
    const requestOrigin = req.headers.origin;
    const secFetchMode = req.headers["sec-fetch-mode"];
    const pathToken = (req.url ?? "/").replace(/^\//, "").split("?")[0];
    const originOk =
      typeof requestOrigin === "string" &&
      originsMatch(requestOrigin, opts.origin);

    if (req.method === "OPTIONS") {
      if (originOk) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": requestOrigin as string,
          Vary: "Origin",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        });
      } else {
        res.writeHead(403);
      }
      res.end();
      return;
    }

    if (pathToken !== opts.token) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!originOk) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (secFetchMode !== "cors") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (used) {
      res.writeHead(410);
      res.end();
      return;
    }
    used = true;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": requestOrigin as string,
      Vary: "Origin",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ user: opts.values.user, pass: opts.values.pass }));
    // Let the response flush before tearing the socket down.
    setTimeout(stop, 50);
  });

  const ttlTimer = setTimeout(stop, ttlMs);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, closed, stop });
    });
  });
}
