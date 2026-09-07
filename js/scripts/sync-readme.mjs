/**
 * Copy the repository README and LICENSE into the package directory.
 *
 * npm renders `js/README.md` as the package page, and that page is the only
 * thing most people ever read about this library. Keeping a second hand-written
 * copy would drift, so the root README stays the single source and this script
 * derives the npm copy from it.
 *
 * The one thing that cannot be copied verbatim is links: `[SECURITY.md](SECURITY.md)`
 * resolves against the repository on GitHub and against nothing at all on npm.
 * Repo-relative link targets are rewritten to absolute GitHub URLs, taken from
 * the `repository` field so there is exactly one place to change the owner.
 *
 * Run by `prepublishOnly`; also `npm run sync:readme` to refresh by hand.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..");

const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));

/** `git+https://github.com/owner/repo.git` -> `https://github.com/owner/repo` */
function repoWebUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) throw new Error("package.json needs a `repository` field to rewrite README links");
  const web = url.replace(/^git\+/, "").replace(/\.git$/, "");
  if (!web.startsWith("https://")) throw new Error(`unsupported repository url: ${url}`);
  return web;
}

const blobBase = `${repoWebUrl(pkg.repository)}/blob/main`;

/**
 * Rewrite `[text](path)` where `path` points at a file in this repository.
 *
 * Left alone: absolute URLs, in-page anchors, and protocol-relative links —
 * those already resolve wherever the page is rendered.
 */
function absolutiseLinks(markdown) {
  return markdown.replace(/\]\((?!https?:|\/\/|#|mailto:)([^)\s]+)(\s+"[^"]*")?\)/g, (_m, target, title = "") => {
    const [path, anchor = ""] = target.split("#");
    // A bare `#anchor` was excluded above; this catches `file.md#anchor`.
    return `](${blobBase}/${path.replace(/^\.\//, "")}${anchor && `#${anchor}`}${title})`;
  });
}

const readme = absolutiseLinks(readFileSync(resolve(repoRoot, "README.md"), "utf8"));
writeFileSync(resolve(packageDir, "README.md"), readme);
writeFileSync(resolve(packageDir, "LICENSE"), readFileSync(resolve(repoRoot, "LICENSE")));

console.log(`synced README.md (${readme.length} bytes) and LICENSE into ${pkg.name}`);
