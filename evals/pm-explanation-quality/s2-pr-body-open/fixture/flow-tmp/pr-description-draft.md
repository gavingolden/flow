## Why

`bin/lib/claude-headless.ts`'s `parseArgs` (around :111-217) had no case for a
`--tools` flag, so `buildChildArgv` (:237) could never append one. We added
`out.tools = value` to the `switch` at the `--tools` case, widened the `Args`
type at :89-101 with an optional `tools?: string` field, and appended
`["--tools", a.tools]` to the array returned by `buildChildArgv` only when
`a.tools !== undefined`. `bin/flow-claude-headless.test.ts` gained two new
`it()` blocks under the existing `describe("buildChildArgv")` at :295-396
asserting the appended pair and byte-identical argv when the flag is absent.

## User-facing changes

`Args.tools` is now `tools?: string`. `parseArgs` accepts a `--tools <value>`
flag, including an empty-string value, without triggering the `--prompt`
`startsWith('--')` guard because that guard is scoped to the `--prompt` case
only. `buildChildArgv`'s return array conditionally spreads
`["--tools", a.tools]` at the end, after the existing `...(a.bare ? ["--bare"]
: [])` spread. Every call site that does not pass `--tools` gets an argv
array that is `toEqual`-identical to the pre-change array, per the new
`"leaves argv byte-identical to today when --tools is absent"` test case.
