#!/usr/bin/env bun
/**
 * Schema validator for the consumer-declared `.flow/ui-validation.json`
 * manifest — the "how to launch + authenticate + which routes" convention
 * the browser-driven UI-validation capability reads at Step 6 (`/verify`)
 * and Step 8c (`/pr-review`).
 *
 * Unlike `.flow/pre-commit.json` (a top-level ARRAY of scopes), this
 * manifest is a single OBJECT: `{ launch, baseUrl, loginUrl?,
 * credentialEnvVars?, routes, disableAnimations?, ignoreConsolePatterns?,
 * ignoreRequestPatterns? }`. The validator mirrors
 * `bin/lib/pr-review-result-schema.ts`'s `validate*()` / `ValidationResult<T>`
 * / `--validate` CLI shape and borrows `bin/lib/agent-finding-schema.ts`'s
 * nested-array idiom for the `routes[]` array of `{ path, expectSelectors? }`.
 *
 * Strict on shape, permissive on content: required keys present + typed,
 * but NOT no-extra-keys — an example manifest carries `_comment`-style
 * documentation keys, and the validator tolerates any unknown key. This
 * module is an INTERNAL import of `bin/flow-ui-validate.ts` only; it is not
 * registered in `bin/lib/sources.ts`'s `VALIDATOR_MODULES` allowlist
 * because no pipeline skill invokes it by bare name.
 *
 * CLI mode: `bun bin/lib/ui-validation-schema.ts --validate <path>` —
 * reads the file, parses JSON, runs the validator, prints `{ok: true}` to
 * stdout (exit 0) or `{ok: false, reason, path}` to stderr (exit 1).
 */

export type UiValidationRoute = {
  path: string;
  expectSelectors?: string[];
};

export type UiValidationCredentialEnvVars = {
  user: string;
  pass: string;
};

export type Viewport = {
  name: string;
  width: number;
  height?: number;
};

export type UiValidationManifest = {
  launch: string;
  baseUrl: string;
  loginUrl?: string;
  credentialEnvVars?: UiValidationCredentialEnvVars;
  env?: Record<string, string>;
  routes: UiValidationRoute[];
  disableAnimations?: boolean;
  ignoreConsolePatterns?: string[];
  ignoreRequestPatterns?: string[];
  viewports?: Viewport[];
};

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; reason: string; path?: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(reason: string, path?: string): ValidationErr {
  return { ok: false, reason, path };
}

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function validateRoute(
  r: unknown,
  idx: number,
): ValidationResult<UiValidationRoute> {
  if (!isPlainObject(r)) {
    return err(`routes[${idx}] must be an object`);
  }
  if (!isNonEmptyString(r.path)) {
    return err(`routes[${idx}].path must be a non-empty string`);
  }
  if (r.expectSelectors !== undefined && !isStringArray(r.expectSelectors)) {
    return err(
      `routes[${idx}].expectSelectors must be an array of strings when present`,
    );
  }
  return { ok: true, value: r as unknown as UiValidationRoute };
}

function validateViewport(v: unknown, idx: number): ValidationResult<Viewport> {
  if (!isPlainObject(v)) {
    return err(`viewports[${idx}] must be an object`);
  }
  if (!isNonEmptyString(v.name)) {
    return err(`viewports[${idx}].name must be a non-empty string`);
  }
  if (!isPositiveFiniteNumber(v.width)) {
    return err(`viewports[${idx}].width must be a positive number`);
  }
  if (v.height !== undefined && !isPositiveFiniteNumber(v.height)) {
    return err(
      `viewports[${idx}].height must be a positive number when present`,
    );
  }
  return { ok: true, value: v as unknown as Viewport };
}

export function validateUiValidationManifest(
  parsed: unknown,
): ValidationResult<UiValidationManifest> {
  if (!isPlainObject(parsed)) {
    return err("ui-validation manifest must be a JSON object");
  }

  if (!isNonEmptyString(parsed.launch)) {
    return err("'launch' must be a non-empty string (the dev-server command)");
  }
  if (!isNonEmptyString(parsed.baseUrl)) {
    return err(
      "'baseUrl' must be a non-empty string (e.g. http://localhost:5173)",
    );
  }

  if (parsed.loginUrl !== undefined && !isNonEmptyString(parsed.loginUrl)) {
    return err("'loginUrl' must be a non-empty string when present");
  }

  if (parsed.credentialEnvVars !== undefined) {
    if (!isPlainObject(parsed.credentialEnvVars)) {
      return err("'credentialEnvVars' must be an object when present");
    }
    if (!isNonEmptyString(parsed.credentialEnvVars.user)) {
      return err(
        "'credentialEnvVars.user' must be a non-empty string (the env-var NAME, not the value)",
      );
    }
    if (!isNonEmptyString(parsed.credentialEnvVars.pass)) {
      return err(
        "'credentialEnvVars.pass' must be a non-empty string (the env-var NAME, not the value)",
      );
    }
  }

  if (parsed.env !== undefined) {
    if (!isPlainObject(parsed.env)) {
      return err(
        "'env' must be an object of string→string launch-config overrides when present",
      );
    }
    for (const [key, value] of Object.entries(parsed.env)) {
      // VALUES are config strings (ports, URLs, CORS origins) — empty is
      // allowed; only non-string values are rejected. Keys are arbitrary.
      if (!isString(value)) {
        return err(`'env.${key}' must be a string value`);
      }
    }
  }

  if (!Array.isArray(parsed.routes)) {
    return err("'routes' must be an array");
  }
  for (let i = 0; i < parsed.routes.length; i++) {
    const r = validateRoute(parsed.routes[i], i);
    if (!r.ok) return r;
  }

  if (
    parsed.disableAnimations !== undefined &&
    typeof parsed.disableAnimations !== "boolean"
  ) {
    return err("'disableAnimations' must be a boolean when present");
  }

  if (
    parsed.ignoreConsolePatterns !== undefined &&
    !isStringArray(parsed.ignoreConsolePatterns)
  ) {
    return err(
      "'ignoreConsolePatterns' must be an array of strings when present",
    );
  }
  if (
    parsed.ignoreRequestPatterns !== undefined &&
    !isStringArray(parsed.ignoreRequestPatterns)
  ) {
    return err(
      "'ignoreRequestPatterns' must be an array of strings when present",
    );
  }

  if (parsed.viewports !== undefined) {
    if (!Array.isArray(parsed.viewports)) {
      return err("'viewports' must be an array when present");
    }
    // An explicit empty array is a zero-capture footgun: the drive would
    // render no viewports, strictly worse than omitting the key (which
    // applies the built-in default set). Require non-empty when present.
    if (parsed.viewports.length === 0) {
      return err(
        "'viewports' must be non-empty when present (omit the key to get the built-in default set)",
      );
    }
    for (let i = 0; i < parsed.viewports.length; i++) {
      const v = validateViewport(parsed.viewports[i], i);
      if (!v.ok) return v;
    }
  }

  return { ok: true, value: parsed as UiValidationManifest };
}

async function cliMain(argv: string[]): Promise<number> {
  const flagIdx = argv.indexOf("--validate");
  if (flagIdx === -1 || flagIdx === argv.length - 1) {
    process.stderr.write(
      "usage: ui-validation-schema --validate <path-to-ui-validation.json>\n",
    );
    return 2;
  }
  const path = argv[flagIdx + 1];
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({ ok: false, reason: `read failed: ${reason}`, path }) +
        "\n",
    );
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: `JSON parse failed: ${reason}`,
        path,
      }) + "\n",
    );
    return 1;
  }
  const result = validateUiValidationManifest(parsed);
  if (result.ok) {
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    return 0;
  }
  process.stderr.write(
    JSON.stringify({ ok: false, reason: result.reason, path }) + "\n",
  );
  return 1;
}

if (import.meta.main) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
