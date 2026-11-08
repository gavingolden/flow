# Demo GIF

`demo.gif` is rendered from `demo.tape` with [VHS](https://github.com/charmbracelet/vhs):

```sh
vhs docs/demo/demo.tape
```

The tmux demo renders the same way:

```sh
env -u TMUX -u TMUX_PANE -u FLOW_SLUG vhs docs/demo/tmux.tape
```

It runs a private `tmux -L flow-demo` server under a throwaway HOME, loads `docs/tmux-tree.conf`, and must be re-rendered whenever that file changes.

The tape is a **simulation** — it shadows `flow` with a shell function that prints contrived, illustrative output, and never runs the real tool. Edit the tape, re-render, and commit both files together.
