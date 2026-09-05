# f6 workflow-port probes

Maintainer-run, live-only probes settling whether the Workflow tool can run
an inline agent script and whether a plugin-supplied `.workflow.js` is
dispatchable by its plugin-qualified command name. Run with:

```sh
bun bin/flow-plugin-probe.ts --json --live --probe workflow-headless-await
bun bin/flow-plugin-probe.ts --json --live --probe workflow-plugin-command
```

| Probe                     | Verdict                  | Evidence         |
| ------------------------- | ------------------------ | ---------------- |
| `workflow-headless-await` | pending (maintainer-run) | not yet run live |
| `workflow-plugin-command` | pending (maintainer-run) | not yet run live |
