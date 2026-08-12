# Security Review Checklist

Checks for the **security** lens. Soft cap: ~150 lines — condense, merge duplicates, or move
consumer-specific entries to `docs/consumer-review-patterns.md` before adding new entries.
New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture the gap") — see that
step for the two-destination contract; never edit this file outside that flow.

---

## Security

Code that handles user input, authentication, authorization, or external data needs careful
scrutiny. A single missed validation can become an exploitable vulnerability.

### What to look for

- User input flowing into database queries, shell commands, HTML output, or file paths
- Authentication or authorization checks that could be bypassed
- Hardcoded secrets, API keys, tokens, or passwords in source files
- Sensitive data in logs, error messages, or client-facing responses
- `eval()`, `innerHTML`, `dangerouslySetInnerHTML`, or template literals in SQL
- CORS configuration changes, especially wildcard origins
- File upload handling without type/size/path validation
- Cryptographic operations using weak algorithms or hardcoded keys

### How to check

1. Trace data flow from input to use — is every user-provided value validated and sanitized
   before reaching a sensitive operation?
2. For auth changes: verify the check happens server-side, not just in the UI
3. Search the diff for string literals that look like keys/tokens (high entropy, base64, `sk-`, `pk-`)
4. For SQL: verify parameterized queries are used, not string concatenation
5. For HTML output: verify user content is escaped or rendered through a safe framework API
6. For file operations: verify paths are validated against traversal (`../`)

### Confidence guidance

- Hardcoded secret in source: 95+ (almost always a real issue)
- SQL string concatenation with user input: 90+ (clear injection vector)
- Missing server-side auth check: 85-95 (depends on whether client-side check exists)
- CORS wildcard on a non-public API: 85-90

**General rule:** If user-controlled data reaches a sensitive operation without validation,
that's an `issue (blocking)`. If validation exists but could be stronger, that's a
`suggestion (non-blocking)`.
