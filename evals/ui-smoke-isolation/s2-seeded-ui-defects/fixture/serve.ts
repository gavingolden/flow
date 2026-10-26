#!/usr/bin/env bun
// Zero-dependency Bun static app: serves public/ with no build step and
// no `npm install`, so the eval fixture stays hermetic. `/` maps to
// `public/index.html`; every other path serves the matching file under
// `public/` verbatim.
Bun.serve({
  port: Number(process.env.PORT),
  fetch: (req) =>
    new Response(
      Bun.file(
        "public" +
          (new URL(req.url).pathname === "/"
            ? "/index.html"
            : new URL(req.url).pathname),
      ),
    ),
});
