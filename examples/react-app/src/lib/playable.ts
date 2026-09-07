import { downloadZip } from "bitrate-js/zip";

/**
 * Turn in-memory HLS output into something a player can load.
 *
 * The packager emits files with **relative** URIs, which is what makes the same
 * output play from any storage. Nothing is uploaded here, so each file becomes a
 * `blob:` URL and the playlists are rewritten to point at those — a demo-only
 * step that real deployments never need.
 */

export interface PackagedFile {
  name: string;
  blob: Blob;
  contentType: string;
  isManifest: boolean;
}

export interface PlayableOutput {
  /** URL to hand to hls.js or a `<video src>`. */
  url: string;
  /** Every object URL created, so they can be revoked. */
  revoke: () => void;
}

/**
 * Rewrite `files` into blob URLs and return the entry playlist's URL.
 *
 * Playlists are rewritten in two passes because a master playlist points at
 * media playlists, which in turn point at segments.
 */
export async function toPlayable(
  files: readonly PackagedFile[],
  entryName: string,
): Promise<PlayableOutput> {
  const created: string[] = [];
  const track = (url: string) => {
    created.push(url);
    return url;
  };

  // Pass 1: media files (segments and init) get URLs.
  const mediaUrls = new Map<string, string>();
  for (const file of files) {
    if (!file.name.endsWith(".m3u8")) {
      mediaUrls.set(file.name, track(URL.createObjectURL(file.blob)));
    }
  }

  // Pass 2: rendition playlists, with their segment URIs replaced.
  const playlistUrls = new Map<string, string>();
  for (const file of files) {
    if (!file.name.endsWith(".m3u8") || file.name === entryName) continue;
    let text = await file.blob.text();
    for (const [name, url] of mediaUrls) text = text.split(name).join(url);
    playlistUrls.set(
      file.name,
      track(URL.createObjectURL(new Blob([text], { type: "application/vnd.apple.mpegurl" }))),
    );
  }

  // Finally the entry playlist, which may reference either kind.
  const entry = files.find((f) => f.name === entryName);
  if (!entry) throw new Error(`playlist ${entryName} is missing from the output`);

  let entryText = await entry.blob.text();
  for (const [name, url] of playlistUrls) entryText = entryText.split(name).join(url);
  for (const [name, url] of mediaUrls) entryText = entryText.split(name).join(url);

  const url = track(
    URL.createObjectURL(new Blob([entryText], { type: "application/vnd.apple.mpegurl" })),
  );

  return {
    url,
    revoke: () => created.forEach((u) => URL.revokeObjectURL(u)),
  };
}

/** The playlist a player should open: the master when there is one. */
export function entryPlaylist(files: readonly PackagedFile[]): string | null {
  const playlists = files.filter((f) => f.name.endsWith(".m3u8"));
  if (playlists.length === 0) return null;
  return (playlists.find((f) => f.name.includes("master")) ?? playlists[0]!).name;
}

/**
 * Save the whole output as one archive.
 *
 * A rendition is a dozen or more files, and saving them individually makes the
 * browser prompt about multiple downloads and scatters them into the downloads
 * folder — where they are no longer next to the playlist that references them.
 */
export async function downloadAsZip(
  files: readonly PackagedFile[],
  name = "hls-output",
): Promise<void> {
  await downloadZip(
    files.map((f) => ({ name: f.name, data: f.blob })),
    `${name}.zip`,
  );
}

/** Save each file separately — the fallback when an archive is impractical. */
export function downloadEach(files: readonly PackagedFile[]): void {
  files.forEach((file, i) => {
    // Browsers throttle rapid programmatic downloads; space them out.
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file.blob);
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, i * 140);
  });
}
