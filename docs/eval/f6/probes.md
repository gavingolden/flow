# f6 workflow-port probes

Maintainer-run, live-only probes settling whether the Workflow tool can run
an inline agent script and whether a plugin-supplied `.workflow.js` is
dispatchable by its plugin-qualified command name. Run with:

```sh
bun bin/flow-plugin-probe.ts --json --live --probe workflow-headless-await
bun bin/flow-plugin-probe.ts --json --live --probe workflow-plugin-command
```

| Probe                     | Verdict   | Evidence                                                                                                                                                         |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-headless-await` | confirmed | Workflow tool inline one-agent script (exit 0, nonce found in stdout): Return value: `wf-nonce-n2anazso`                                                         |
| `workflow-plugin-command` | confirmed | plugin-dir workflows: ["./workflows"] manifest entry, dispatched by plugin-qualified name (exit 0, nonce found=true): Return value: `"wf-plugin-nonce-w3ytgpuh"` |

Recorded 2026-09-06 from a plain shell (`claude --version` 2.1.263), both verdicts verbatim from the `--json` envelope.
