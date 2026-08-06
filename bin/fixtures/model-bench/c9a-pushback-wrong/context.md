# Source: `rebaseOntoInstallRoot` (bin/lib/sources.ts)

The following is the exact, current implementation and its preceding JSDoc comment, taken from flow's `bin/lib/sources.ts`:

```ts
/**
 * Rebase a `flowSource`-rooted path onto `installRoot`. Identity in the two
 * cases where rebasing is meaningless: when the two roots are the same (the
 * non-`--source` common case), and when `source` does not live under
 * `flowSource` (`path.relative` escapes with a leading `..`, or is absolute —
 * e.g. the `flow` wrapper, which is already `installRoot`-anchored). The
 * `..`-guard hardens what previously worked only because
 * `flow-new-worktree` guarantees canonical/worktree are same-depth siblings;
 * a non-sibling layout would otherwise produce a wrong `path.join` result.
 */
export function rebaseOntoInstallRoot(
  source: string,
  flowSource: string,
  installRoot: string,
): string {
  if (path.resolve(flowSource) === path.resolve(installRoot)) return source;
  const rel = path.relative(flowSource, source);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return source;
  return path.join(installRoot, rel);
}
```

Documented behavior, restated plainly: `rebaseOntoInstallRoot` takes a path `source` that is assumed to live somewhere under `flowSource`, and rewrites it to the equivalent path under `installRoot`. It returns `source` completely unchanged in exactly two situations: (1) `flowSource` and `installRoot` resolve to the same path, or (2) `source` does not actually live under `flowSource` — detected via `path.relative(flowSource, source)` starting with `".."` or being absolute. Only when neither identity case applies does it `path.join(installRoot, rel)` and return a rebased path.
