/**
 * Shared enum-value-flag parser for `--effort`/`--model`/`--model-planning`
 * (epic-create) and `--model`/`--effort` (epic-launch overrides). Owns the
 * missing-value guard, the enum check, and the two-line error message shape
 * (`flow epic <verb>: <flag> requires a value.` / `flow epic <verb>: invalid
 * <flag> value '<v>'.`, each followed by `  expected one of: <expected>`) —
 * the exact shape epic-create's original inline blocks printed. Returns the
 * flag's `flagIndex` (the position of the flag token itself, so a caller can
 * strip BOTH the flag and its value token by index) alongside the parsed
 * `value`; a flag that is absent from `rest` returns `{}`; a missing/invalid
 * value prints the error and returns `{ error: true }` — the caller must
 * exit 2 before any side effect (manifest load, spawn, state write).
 */
export function parseEnumValueFlag<T extends string>(
  rest: string[],
  flag: string,
  allowed: readonly T[],
  verb: string,
  expected: string,
): { value?: T; valueToken?: string; flagIndex?: number; error?: true } {
  const idx = rest.indexOf(flag);
  if (idx < 0) return {};
  if (rest.indexOf(flag, idx + 1) >= 0) {
    console.error(`flow epic ${verb}: ${flag} may only be specified once.`);
    return { error: true };
  }
  const value = rest[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`flow epic ${verb}: ${flag} requires a value.`);
    console.error(`  expected one of: ${expected}`);
    return { error: true };
  }
  if (!(allowed as readonly string[]).includes(value)) {
    console.error(`flow epic ${verb}: invalid ${flag} value '${value}'.`);
    console.error(`  expected one of: ${expected}`);
    return { error: true };
  }
  return { value: value as T, valueToken: value, flagIndex: idx };
}

/**
 * Free-string sibling of `parseEnumValueFlag`: same once-only and
 * missing-value guards and the same `flagIndex`, but any non-`--` token is
 * accepted as the value (a path, say) — so the caller can strip BOTH tokens by
 * index and never mistake the value for a positional.
 */
export function parseStringValueFlag(
  rest: string[],
  flag: string,
  verb: string,
  expected: string,
): { value?: string; flagIndex?: number; error?: true } {
  const idx = rest.indexOf(flag);
  if (idx < 0) return {};
  if (rest.indexOf(flag, idx + 1) >= 0) {
    console.error(`flow epic ${verb}: ${flag} may only be specified once.`);
    return { error: true };
  }
  const value = rest[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`flow epic ${verb}: ${flag} requires a value.`);
    console.error(`  expected: ${expected}`);
    return { error: true };
  }
  return { value, flagIndex: idx };
}
