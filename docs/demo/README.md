# Demo images

`tmux-tree.svg` is the image in the README's tmux section. Build it with:

```sh
./docs/demo/render-tmux-tree.ts
```

It needs [VHS](https://github.com/charmbracelet/vhs) and tmux. The script runs `tmux.tape` on a private `tmux -L flow-demo` server under a throwaway HOME with invented pipelines, loads `docs/tmux-tree.conf`, takes a screenshot, then adds the numbered markers.

Re-render whenever `docs/tmux-tree.conf` or the tape changes, and commit the tape, the script, and the SVG together. The marker positions match the tape's Width, FontSize and Padding, the column widths in `docs/tmux-tree.conf`, and the six seeded windows; change any of them and re-measure the markers in the script.

The tape never runs the real `flow`.
