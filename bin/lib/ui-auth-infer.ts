/**
 * Pure auth inference for the browser-driven UI-validation bootstrap. Picks a
 * `loginUrl` candidate from the derived routes and mines credential env-var
 * NAMES from `.env.example` (or `.env`).
 *
 * This module embodies the secret-value guardrail on the inference side: it
 * emits env-var NAMES and non-secret config only — never a secret value. Even
 * when a populated `.env` (with real VALUES) is supplied, only KEYS are read
 * and only KEYS are returned; a VALUE never enters the output.
 *
 * Internal import of `bin/flow-ui-validate.ts` only, NOT PATH-registered.
 */

export type InferAuthArgs = {
  routes: string[];
  envExampleText?: string;
  envText?: string;
};

export type CredentialEnvVars = { user: string; pass: string };

export type AuthInference = {
  loginUrl?: string;
  credentialEnvVars?: CredentialEnvVars;
};

/**
 * Parse the KEYS out of a dotenv-format file. Values are deliberately
 * discarded here at the boundary — nothing downstream can leak a VALUE it
 * never received.
 */
function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function pickLoginUrl(routes: string[]): string | undefined {
  const lower = (r: string) => r.toLowerCase();
  // Exact matches first, then substring, honoring "prefer the most confident".
  return (
    routes.find((r) => lower(r) === "/login") ??
    routes.find((r) => lower(r) === "/auth") ??
    routes.find((r) => lower(r).includes("login")) ??
    routes.find((r) => lower(r).includes("auth")) ??
    undefined
  );
}

// A credential name scores higher when it looks like a purpose-built test /
// e2e account var, so those win over an incidental app config var.
function score(name: string): number {
  const upper = name.toUpperCase();
  let s = 0;
  if (upper.startsWith("TEST_")) s += 3;
  if (upper.startsWith("E2E_")) s += 3;
  if (upper.includes("TEST")) s += 1;
  return s;
}

function pickBest(names: string[], suffixes: RegExp): string | undefined {
  const matches = names.filter((n) => suffixes.test(n.toUpperCase()));
  if (matches.length === 0) return undefined;
  return matches.slice().sort((a, b) => score(b) - score(a))[0];
}

export function inferAuth(args: InferAuthArgs): AuthInference {
  const out: AuthInference = {};

  const loginUrl = pickLoginUrl(args.routes);
  if (loginUrl) out.loginUrl = loginUrl;

  // Mine NAMES from the example first (the canonical source), then the real
  // `.env` — KEYS only from either. De-dup preserving first-seen order.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const text of [args.envExampleText, args.envText]) {
    if (!text) continue;
    for (const key of parseEnvKeys(text)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }

  // Prefer an email-style user var, then username, then a bare *_USER.
  const user =
    pickBest(names, /_EMAIL$/) ??
    pickBest(names, /_USERNAME$/) ??
    pickBest(names, /_USER$/);
  const pass = pickBest(names, /_PASSWORD$/) ?? pickBest(names, /_PASS$/);

  if (user && pass) out.credentialEnvVars = { user, pass };

  return out;
}
