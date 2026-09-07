/**
 * Rewriting playlist URIs for storage that does not serve files by path.
 *
 * Playlists reference their segments **relatively**, which is what lets the
 * same output play from any bucket without modification — as long as a segment
 * really does sit next to the playlist.
 *
 * Some storage does not work that way. Appwrite addresses files by id:
 *
 * ```
 * …/buckets/videos/files/<fileId>/view?project=…
 * ```
 *
 * A relative reference there resolves under the *playlist's* URL and 404s. The
 * symptom is a player that loads the playlist and then stalls forever, which is
 * a slow thing to diagnose. Rewriting the URIs to absolute URLs fixes it.
 *
 * The playlist is emitted last, so every segment's URL is already known by the
 * time this is needed.
 */

/** Resolve one referenced file name to a URL, or `undefined` to leave it alone. */
export type UriResolver = (name: string) => string | undefined;

/** Lines that carry a `URI="…"` attribute rather than a bare URI. */
const URI_ATTRIBUTE = /URI="([^"]*)"/g;

/**
 * Replace every file reference in `playlist` using `resolve`.
 *
 * Handles both places a playlist names a file: bare URI lines (segments, and
 * rendition playlists under `#EXT-X-STREAM-INF`) and `URI="…"` attributes
 * (`#EXT-X-MAP`, `#EXT-X-MEDIA`).
 *
 * @example
 * ```ts
 * const urls = new Map([["seg0.m4s", "https://cdn/abc/view"]]);
 * rewritePlaylistUris(text, (name) => urls.get(name));
 * ```
 */
export function rewritePlaylistUris(playlist: string, resolve: UriResolver): string {
  return playlist
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;

      if (trimmed.startsWith("#")) {
        // Tags never reference a file except through a URI attribute.
        return line.replace(URI_ATTRIBUTE, (whole, name: string) => {
          const url = resolve(name);
          return url === undefined ? whole : `URI="${url}"`;
        });
      }

      // A bare line is a URI: a segment, or a rendition playlist in a master.
      const url = resolve(trimmed);
      return url === undefined ? line : url;
    })
    .join("\n");
}

/** Every file a playlist references, in the order it names them. */
export function playlistReferences(playlist: string): string[] {
  const found: string[] = [];

  for (const line of playlist.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("#")) {
      for (const match of trimmed.matchAll(URI_ATTRIBUTE)) {
        if (match[1]) found.push(match[1]);
      }
    } else {
      found.push(trimmed);
    }
  }
  return found;
}
