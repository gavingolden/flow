/**
 * Images embedded from outside GitHub's native attachments. A link into the
 * PR's own repo (`blob/<ref>/x.png?raw=true`, `raw.githubusercontent.com`) is
 * re-hosted natively at push time, so an improvised image branch can be
 * deleted without breaking the PR; every other outside host is only flagged.
 */
import { imageRefs } from "./image-refs";

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i;

const PUBLIC_IMAGE_HOSTS = [
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "gist.github.com",
  "imgur.com",
  "postimg.cc",
  "ibb.co",
  "imgbb.com",
  "prnt.sc",
  "gyazo.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "i.redd.it",
  "pbs.twimg.com",
  "res.cloudinary.com",
];

type RepoImage = { repo: string; ref: string; path: string };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** `owner/repo`, ref and path of a GitHub-served repo file, or null. */
function parseRepoImage(url: URL): RepoImage | null {
  const parts = url.pathname.split("/").filter(Boolean).map(decode);
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    return {
      repo: `${parts[0]}/${parts[1]}`.toLowerCase(),
      ref: parts[2],
      path: parts.slice(3).join("/"),
    };
  }
  if (
    url.hostname === "github.com" &&
    parts.length >= 5 &&
    (parts[2] === "raw" ||
      (parts[2] === "blob" && url.searchParams.get("raw") === "true"))
  ) {
    return {
      repo: `${parts[0]}/${parts[1]}`.toLowerCase(),
      ref: parts[3],
      path: parts.slice(4).join("/"),
    };
  }
  return null;
}

function parseUrl(target: string): URL | null {
  if (!/^https?:\/\//i.test(target)) return null;
  try {
    return new URL(target);
  } catch {
    return null;
  }
}

function onPublicHost(host: string): boolean {
  return PUBLIC_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** True when the body links a GitHub-served repo file (any repo) as an image. */
export function hasRepoRawLinks(body: string): boolean {
  return imageRefs(body).some((r) => {
    const url = parseUrl(r.target);
    return url !== null && parseRepoImage(url) !== null;
  });
}

export function classifyExternalImages(
  body: string,
  prRepo: string,
): {
  rehostable: { src: string; ref: string; path: string }[];
  flagged: string[];
} {
  const rehostable = new Map<
    string,
    { src: string; ref: string; path: string }
  >();
  const flagged = new Set<string>();
  for (const r of imageRefs(body)) {
    const url = parseUrl(r.target);
    if (url === null) continue;
    const file = parseRepoImage(url);
    if (
      file !== null &&
      prRepo !== "" &&
      file.repo === prRepo.toLowerCase() &&
      IMAGE_PATH_RE.test(file.path)
    ) {
      rehostable.set(r.target, {
        src: r.target,
        ref: file.ref,
        path: file.path,
      });
    } else if (
      file !== null ||
      onPublicHost(url.hostname) ||
      (url.hostname === "github.com" && url.pathname.includes("/blob/"))
    ) {
      flagged.add(r.target);
    }
  }
  return { rehostable: [...rehostable.values()], flagged: [...flagged] };
}

type Exec = (argv: string[]) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Bytes of a repo file. `gh api` has no `--output` and `exec` decodes stdout
 * as text, which corrupts a raw PNG — so read the blob sha, then its base64
 * content (string-safe up to 100 MB).
 */
export function fetchRepoImage(
  exec: Exec,
  repo: string,
  file: { ref: string; path: string },
): { bytes: Buffer } | { error: string } {
  const encoded = file.path.split("/").map(encodeURIComponent).join("/");
  const meta = exec([
    "gh",
    "api",
    `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(file.ref)}`,
    "--jq",
    ".sha",
  ]);
  const sha = meta.stdout.trim();
  if (meta.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { error: meta.stderr.trim() || "contents lookup failed" };
  }
  const blob = exec([
    "gh",
    "api",
    `repos/${repo}/git/blobs/${sha}`,
    "--jq",
    ".content",
  ]);
  const bytes = Buffer.from(blob.stdout.replace(/\s/g, ""), "base64");
  if (blob.exitCode !== 0 || bytes.length === 0) {
    return { error: blob.stderr.trim() || "blob download failed" };
  }
  return { bytes };
}
