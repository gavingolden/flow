/**
 * Pure launch + free-port inference for the browser-driven UI-validation
 * bootstrap. Reads a `package.json`'s scripts to infer how to bring the app
 * up (prefer `dev`, fall back to `start`) and expresses the port as the
 * literal `{{PORT}}` placeholder token — never a frozen constant — so a
 * hardcoded port can't collide across parallel pipelines. The helper
 * re-resolves the placeholder to a freshly-allocated free port each run via
 * `allocFreePort()` + `resolvePortPlaceholder()`.
 *
 * Internal import of `bin/flow-ui-validate.ts` (launch inference + free-port
 * resolution) and `bin/lib/ui-validation-schema.ts` (the `PORT_PLACEHOLDER`
 * sentinel, for the bidirectional server/client {{PORT}}-consistency
 * invariant) only, NOT PATH-registered.
 */

import * as net from "node:net";

// The literal placeholder token the persisted manifest carries in place of a
// concrete port. A literal string-replace at run time (not shell expansion)
// keeps it immune to `$`-mangling and cross-shell quoting.
export const PORT_PLACEHOLDER = "{{PORT}}";

export type LaunchInfo = {
  launch: string;
  baseUrl: string;
};

/**
 * Infer the launch command + baseUrl from a package.json's scripts. Returns
 * null when neither a `dev` nor a `start` script exists (nothing to launch).
 * The returned form carries the `{{PORT}}` placeholder, never a literal port.
 */
export function inferLaunch(packageJsonText: string): LaunchInfo | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  if (typeof pkg !== "object" || pkg === null) return null;
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;

  const scriptName =
    typeof (scripts as Record<string, unknown>).dev === "string"
      ? "dev"
      : typeof (scripts as Record<string, unknown>).start === "string"
        ? "start"
        : null;
  if (scriptName === null) return null;

  return {
    // Inject the port via a leading env assignment — the generic, framework-
    // agnostic form the smoketest empirically verifies and adapts if the dev
    // server wants a different flag.
    launch: `PORT=${PORT_PLACEHOLDER} npm run ${scriptName}`,
    baseUrl: `http://localhost:${PORT_PLACEHOLDER}`,
  };
}

/**
 * Allocate a free TCP port by binding to :0, reading the OS-assigned port, and
 * closing the listener. Best-effort: the port is free at check time; a caller
 * racing another process could still lose it, which the launch step surfaces
 * as an ordinary launch failure.
 */
export function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("could not read assigned port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

/** Literal-replace every `{{PORT}}` occurrence with a concrete port. */
export function resolvePortPlaceholder(str: string, port: number): string {
  return str.split(PORT_PLACEHOLDER).join(String(port));
}

/**
 * Named-port sentinel grammar: `{{PORT_<NAME>}}` where `<NAME>` is
 * UPPER_SNAKE (leading letter, then letters/digits/underscore). A distinct
 * named sentinel gets its own freshly-allocated port per run, so a manifest
 * that launches two processes (e.g. backend + frontend) can express each
 * one's port distinctly instead of sharing the single bare `{{PORT}}`.
 */
export const NAMED_PORT_RE = /\{\{PORT_([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * Matches any `{{PORT...}}`-shaped token that is neither the bare
 * `{{PORT}}` sentinel nor a well-formed `{{PORT_<NAME>}}` named sentinel —
 * e.g. lowercase names, hyphens, or a missing underscore. Used to flag
 * malformed tokens a manifest author probably meant as a port sentinel.
 */
export const MALFORMED_PORT_RE = /\{\{PORT[^{}]*\}\}/g;

function isWellFormedPortToken(token: string): boolean {
  if (token === PORT_PLACEHOLDER) return true;
  NAMED_PORT_RE.lastIndex = 0;
  const m = NAMED_PORT_RE.exec(token);
  return m !== null && m[0] === token;
}

export type PortSentinels = {
  bare: boolean;
  named: string[];
  counts: Record<string, number>;
};

/**
 * Scan a set of strings (launch command, baseUrl, loginUrl, env values, ...)
 * for port sentinels. `counts[name]` is the TOTAL number of
 * `{{PORT_<name>}}` occurrences summed across every input string — a caller
 * enforcing "bound and consumed" checks the count, not presence.
 */
export function collectPortSentinels(values: string[]): PortSentinels {
  let bare = false;
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (value.includes(PORT_PLACEHOLDER)) bare = true;
    NAMED_PORT_RE.lastIndex = 0;
    for (const match of value.matchAll(NAMED_PORT_RE)) {
      const name = match[1];
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  const named = Object.keys(counts).sort();
  return { bare, named, counts };
}

/**
 * Return the deduped set of raw `{{PORT...}}`-shaped tokens across `values`
 * that are neither the bare sentinel nor a well-formed named sentinel.
 */
export function findMalformedPortSentinels(values: string[]): string[] {
  const offending = new Set<string>();
  for (const value of values) {
    MALFORMED_PORT_RE.lastIndex = 0;
    for (const match of value.matchAll(MALFORMED_PORT_RE)) {
      if (!isWellFormedPortToken(match[0])) offending.add(match[0]);
    }
  }
  return [...offending];
}

/**
 * Allocate `count` free TCP ports, holding ALL of them open simultaneously
 * before closing any — sequential `allocFreePort()` calls can hand back the
 * OS's just-closed port again, so allocating one at a time cannot guarantee
 * `count` *distinct* ports. Rejects if any bind attempt errors.
 */
export function allocFreePorts(count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (count <= 0) {
      resolve([]);
      return;
    }

    const servers: net.Server[] = [];
    let settled = false;
    let remaining = count;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      for (const s of servers) s.close();
      reject(err);
    };

    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      servers.push(server);
      server.on("error", fail);
      server.listen(0, "127.0.0.1", () => {
        remaining--;
        if (remaining === 0 && !settled) {
          settled = true;
          const ports = servers.map((s) => {
            const addr = s.address();
            return addr !== null && typeof addr !== "string" ? addr.port : -1;
          });
          let closeErr: Error | null = null;
          let pending = servers.length;
          for (const s of servers) {
            s.close((err) => {
              if (err) closeErr = err;
              pending--;
              if (pending === 0) {
                if (closeErr) reject(closeErr);
                else resolve(ports);
              }
            });
          }
        }
      });
    }
  });
}

/**
 * Literal-replace every port sentinel occurrence with its concrete port.
 * Named tokens are resolved first, then the bare `{{PORT}}` token.
 */
export function resolvePorts(
  str: string,
  ports: { bare?: number; named?: Record<string, number> },
): string {
  let result = str;
  if (ports.named) {
    for (const [name, port] of Object.entries(ports.named)) {
      result = result.split(`{{PORT_${name}}}`).join(String(port));
    }
  }
  if (ports.bare !== undefined) {
    result = result.split(PORT_PLACEHOLDER).join(String(ports.bare));
  }
  return result;
}
