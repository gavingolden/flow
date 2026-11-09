# Demo images

`tmux-tree.svg` is the image in the README's tmux section. Build it with:

```sh
./docs/demo/render-tmux-tree.ts
```

To render and check without touching the committed image, run `./docs/demo/render-tmux-tree.ts --check`. The default mode runs the same tree checks and refuses to write a drifted image; only `--check` also compares against the committed image.

It needs [VHS](https://github.com/charmbracelet/vhs) and tmux. The script runs `tmux.tape` on a private `tmux -L flow-demo` server under a throwaway HOME with invented pipelines, loads `docs/tmux-tree.conf`, takes a screenshot, then adds the numbered markers.

Re-render whenever `docs/tmux-tree.conf` or the tape changes, and commit the tape, the script, and the SVG together. The marker positions match the tape's Width, FontSize and Padding, the column widths in `docs/tmux-tree.conf`, and the six seeded windows; change any of them and re-measure the markers in the script. An intended change to the demo (a new row, a renamed title, a wider column) must update four places together: `docs/demo/tmux.tape`, `docs/tmux-tree.conf`, the marker coordinates in `render-tmux-tree.ts`, and the expectations in `tmux-tree-check.ts`.

## What CI checks

The [Demo render workflow](../../.github/workflows/demo-render.yml) runs on PRs touching `docs/demo/**` or `docs/tmux-tree.conf`. It verifies the tape renders, the tree shows the six seeded rows with the right waiting flags, PR, phase and title, the column offsets the markers assume on every row, the PNG size, that the SVG marker markup matches the committed image, and that no demo tmux server is left.

It does not verify marker pixel positions, fonts or colours, or whether the committed screenshot pixels are current. The text check reads the last tree frame, up to ~100 ms after the screenshot, not the screenshot itself. It is not a required check.

The tape never runs the real `flow`.
