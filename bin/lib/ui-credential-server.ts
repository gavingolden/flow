/**
 * The one-time local HTTP endpoint `bin/flow-ui-login.ts serve`'s detached
 * child binds. It answers a single GET with the credential VALUES as JSON —
 * once, to the app's own origin, on a page-initiated `fetch` (never to a
 * bare `curl`) — then shuts itself down.
 *
 * Token-free by design: the URL is a fixed path ({@link CREDENTIAL_LOGIN_PATH}),
 * so the page's `fetch` URL and the `fillScript` carry no secret. The defences
 * are the origin match (403), `Sec-Fetch-Mode: cors` (403), single use (410
 * after the first 200) and the TTL. Any rejected request to the login path
 * also spends the single use (fail closed), and the listener stays up until
 * the TTL answering 410 — with the page's own allowed origin echoed so the
 * page reads the status as `endpoint-refused` rather than a blocked fetch.
 * A mismatched origin is never echoed and `*` is never used.
 *
 * Threat model: a single-user dev machine. Another OS account (or a
 * sandboxed app) on a shared host can reach loopback without any token and
 * could race the page within the TTL. Fail-closed refusals and single use
 * make any interference a visible `credentials-unavailable` stop, but a
 * reader who lost the race is not told the credentials were taken: treat an
 * unexplained `credentials-unavailable` with both variable names present as
 * a possible leak and rotate the seeded test account.
 *
 * `node:http`, not `Bun.serve`: this module is imported directly by
 * `bin/lib/ui-credential-server.test.ts` and `bin/flow-ui-login.test.ts`
 * under vitest, which runs on Node, not the Bun runtime (`Bun` is
 * undefined there).
 *
 * Internal import of `bin/flow-ui-login.ts` only, NOT PATH-registered.
 */

import * as http from "node:http";

export type CredentialServerOpts = {
  values: { user: string; pass: string };
  origin: string;
  ttlMs?: number;
};

export type CredentialServerHandle = {
  port: number;
  closed: Promise<void>;
  stop: () => void;
};

export const DEFAULT_CREDENTIAL_SERVER_TTL_MS = 90_000;

export const CREDENTIAL_LOGIN_PATH = "/flow-ui-login";

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
    server.closeAllConnections?.();
  }

  const server = http.createServer((req, res) => {
    const requestOrigin = req.headers.origin;
    const secFetchMode = req.headers["sec-fetch-mode"];
    const pathOk = (req.url ?? "/").split("?")[0] === CREDENTIAL_LOGIN_PATH;
    const originOk =
      typeof requestOrigin === "string" &&
      originsMatch(requestOrigin, opts.origin);
    // Only an origin that matched is ever echoed — never `*`, never a
    // mismatched origin. It lets the page read a refusal's status (so it
    // reports `endpoint-refused`) instead of its fetch throwing.
    const corsHeaders: http.OutgoingHttpHeaders = originOk
      ? {
          "Access-Control-Allow-Origin": requestOrigin as string,
          Vary: "Origin",
        }
      : {};

    if (!pathOk) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === "OPTIONS") {
      if (originOk) {
        res.writeHead(204, {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        });
      } else {
        used = true;
        res.writeHead(403);
      }
      res.end();
      return;
    }

    if (used) {
      res.writeHead(410, corsHeaders);
      res.end();
      return;
    }
    // Fail closed: a rejected request to the login path spends the single
    // use, so probing origins is not free — the page's later request gets a
    // 410 and the run stops visibly.
    if (!originOk) {
      used = true;
      res.writeHead(403);
      res.end();
      return;
    }
    if (secFetchMode !== "cors") {
      used = true;
      res.writeHead(403, corsHeaders);
      res.end();
      return;
    }
    used = true;
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...corsHeaders,
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ user: opts.values.user, pass: opts.values.pass }));
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
