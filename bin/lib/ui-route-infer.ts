/**
 * Pure, stack-agnostic route derivation for the browser-driven UI-validation
 * bootstrap. Maps a changed file under a `routes/` or `app/` directory to a
 * URL by convention — SvelteKit (`+page.svelte`), Next app-router
 * (`page.tsx`), Remix (`app/routes/…`), and the generic file-per-route case.
 *
 * The load-bearing rule is "emit NO route rather than a wrong one": a URL that
 * can't be confidently derived (a dynamic `[param]` leaf, a colocated
 * PascalCase component, a bare stylesheet) contributes nothing, because a
 * wrong URL 404s and burns a fix-loop attempt on a false negative.
 *
 * Internal import of `bin/flow-ui-validate.ts` only — sibling to
 * `ui-validation-schema.ts`, NOT registered in `bin/lib/sources.ts`'s
 * `VALIDATOR_MODULES` allowlist (no pipeline skill invokes it by bare name).
 */

// Extensions a leaf file must carry to be treated as a route-bearing file.
const ROUTE_LEAF_EXTENSIONS = [".svelte", ".tsx", ".jsx", ".vue", ".ts", ".js"];

// Extensions a *named* (non-boilerplate) leaf may carry to itself name a route
// segment. `.ts`/`.js` are deliberately excluded here: a bare `foo.ts` under
// routes/ is far more likely a loader/util than a page, so only page-shaped
// component extensions promote a named leaf to a route.
const NAMED_LEAF_EXTENSIONS = [".svelte", ".tsx", ".jsx", ".vue"];

// Boilerplate leaf stems where the DIRECTORY is the route and the filename is
// framework convention (SvelteKit `+page`, Next `page`, generic `index`).
const BOILERPLATE_STEMS = new Set(["+page", "page", "index"]);

// Boilerplate stems that are NOT a single concrete page (layouts, endpoints,
// error/loading shells) — a changed one of these has no single URL, so emit
// nothing. Next's `route.ts` Route Handler is a JSON API endpoint (the analog
// of SvelteKit's `+server.ts`), NOT a browseable page, so it lives here.
const NON_PAGE_STEMS = new Set([
  "+layout",
  "+server",
  "+error",
  "route",
  "layout",
  "loading",
  "error",
  "template",
  "not-found",
  "default",
]);

function stripExtension(name: string): { stem: string; ext: string } {
  const lower = name.toLowerCase();
  for (const ext of ROUTE_LEAF_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return { stem: name.slice(0, name.length - ext.length), ext };
    }
  }
  return { stem: name, ext: "" };
}

function isDynamicSegment(seg: string): boolean {
  // `[slug]` / `[...rest]` (SvelteKit, Next), `$slug` (Remix flat), `:id`
  // (generic). Any of these means we cannot confidently name a concrete URL.
  return (
    seg.includes("[") ||
    seg.includes("]") ||
    seg.startsWith("$") ||
    seg.startsWith(":")
  );
}

function isGroupSegment(seg: string): boolean {
  // Route-group segment `(marketing)` — organizational, contributes no URL.
  return seg.startsWith("(") && seg.endsWith(")");
}

/**
 * Locate the route root within a path's segments. Prefer the FIRST `routes`
 * segment, falling back to the FIRST `app` segment only when no `routes`
 * segment exists. This resolves Remix's `app/routes/…` to the inner `routes`
 * root (and Next's bare `app/…` to `app`), while keeping a route directory
 * literally named `app` — e.g. the common authenticated area
 * `src/routes/app/…` — as part of the URL rather than dropping its leading
 * segment.
 */
function routeRootIndex(segments: string[]): number {
  const routesIdx = segments.indexOf("routes");
  if (routesIdx !== -1) return routesIdx;
  return segments.indexOf("app");
}

/** Derive a single URL from one changed file, or null when none is confident. */
function deriveRoute(changedFile: string): string | null {
  const segments = changedFile.split("/").filter((s) => s.length > 0);
  const rootIdx = routeRootIndex(segments);
  if (rootIdx === -1) return null; // not under a routes/app tree

  const after = segments.slice(rootIdx + 1);
  if (after.length === 0) return null;

  const leaf = after[after.length - 1];
  const dirSegments = after.slice(0, after.length - 1);
  const { stem, ext } = stripExtension(leaf);
  const stemLower = stem.toLowerCase();

  // A leaf without a route-bearing extension (a bare `.css`/`.scss`/`.json`
  // etc.) never names a route on its own.
  if (ext === "") return null;

  let routeSegments: string[];
  if (NON_PAGE_STEMS.has(stemLower)) {
    return null; // layout/endpoint/error shell — no single concrete URL
  } else if (BOILERPLATE_STEMS.has(stemLower)) {
    // Directory is the route; the filename is framework boilerplate.
    routeSegments = [...dirSegments];
  } else {
    // Named leaf: the filename itself names the last segment(s). Only page-
    // shaped extensions qualify, and a PascalCase-initial stem is treated as a
    // colocated component (emit nothing) rather than a route.
    if (!NAMED_LEAF_EXTENSIONS.includes(ext)) return null;
    const firstAlpha = stem.replace(/[^A-Za-z]/g, "")[0];
    if (firstAlpha && firstAlpha === firstAlpha.toUpperCase()) return null;
    // Remix flat routes use `.` as a path separator (`settings.profile.tsx`).
    const leafParts = stem.split(".").filter((p) => p.length > 0);
    routeSegments = [...dirSegments, ...leafParts];
  }

  // Strip route groups; bail on any dynamic segment.
  const cleaned: string[] = [];
  for (const seg of routeSegments) {
    if (isGroupSegment(seg)) continue;
    if (isDynamicSegment(seg)) return null;
    cleaned.push(seg);
  }

  return "/" + cleaned.join("/");
}

/**
 * Map a changed-files list to the set of URLs the smoketest should validate.
 * Order-preserving, de-duplicated; files that don't confidently map to a URL
 * are dropped.
 */
export function deriveRoutes(changedFiles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of changedFiles) {
    const route = deriveRoute(file);
    if (route === null) continue;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(route);
  }
  return out;
}
