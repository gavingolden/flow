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
