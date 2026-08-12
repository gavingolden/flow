# Supply-Chain Review Checklist

Checks for the **supply-chain** lens. Soft cap: ~150 lines — condense, merge duplicates, automate deterministic entries into lint, or
move consumer-specific entries to `docs/consumer-review-patterns.md` before adding new
entries. New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture the gap") —
see that step for the two-destination contract; never edit this file at review time — step 5 routes
generic gaps to a filed issue; edits land only via a maintainer PR against the flow repo.

---

## Removing a Top-Level `package.json` Field Breaks an Install Pathway

When a PR drops a top-level field from `package.json` (`bin`, `main`, `exports`, `types`,
`engines`, `files`, `scripts.prepare`, `scripts.postinstall`, etc.), check that no documented
user-facing install or invocation path silently breaks. The deletion is often the _intent_ —
but the docs and any external onboarding flows must be consistent with the new world. A
reader still typing `npm i -g <pkg>` or `npm link` will get a successful install with no
executable shim.

### What to look for

- A `package.json` diff that removes a top-level field, especially `bin`, `main`, `exports`,
  or a lifecycle hook (`prepare`, `postinstall`)
- The same PR removing the only consumer of that field (e.g. deleting `dist/cli.js` along
  with `bin: { "<cmd>": "./dist/cli.js" }`)
- Onboarding docs (`README.md`, install guides) that still mention `npm link` / `npm i -g` /
  `node_modules/.bin/<cmd>`

### How to check

1. List every top-level field removed in the `package.json` diff.
2. For each, identify what install/invocation pathway it enabled (`bin` → `npm i -g`, `main`
   → bare imports, `prepare` → fresh-clone build, etc.).
3. `grep -rn 'npm link\|npm i -g\|npm install -g\|node_modules/.bin'` across `README.md`,
   `docs/`, and onboarding scripts.
4. Confirm any remaining references are explicitly historical / migration text, not "do this
   to install".
5. If the new install path requires a separate command, confirm the README's "Install"
   section is the single source of truth and reads cleanly without the deleted field.

**General rule:** A `package.json` field deletion is half a change. The other half is the
docs that previously assumed it. Cross-check every removed field against `README.md` install
/ quick-start sections before approving.
