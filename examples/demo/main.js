/**
 * Demo: package a video into HLS in the browser, then play the result.
 *
 * Everything happens client-side. The output is kept in memory as object URLs
 * and served to hls.js through a tiny in-page loader, so nothing is uploaded.
 */

import * as bitrate from "bitrate-js";
import { HlsQueue, inspect, isSupported } from "bitrate-js";

// Exposed so the library can be exercised from the devtools console.
window.bitrate = bitrate;
import Hls from "hls.js";

const $ = (id) => document.getElementById(id);
const fileInput = $("file");
const runButton = $("run");

let chosen = null;

// ---- capability report ----------------------------------------------------

const support = isSupported();
$("support").textContent = support.remux
  ? "Ready — remux supported in this browser."
  : `Unsupported: ${support.reasons.join(" ")}`;

// ---- choosing a file ------------------------------------------------------

fileInput.addEventListener("change", async () => {
  chosen = fileInput.files?.[0] ?? null;
  runButton.disabled = !chosen || !support.remux;
  if (!chosen) return;

  setMessage(`Selected ${chosen.name} (${formatBytes(chosen.size)})`);
  try {
    const info = await inspect(chosen);
    $("srcInfo").textContent = `${info.width}×${info.height}, ${info.duration.toFixed(1)}s`;
    $("statusPanel").hidden = false;
  } catch (error) {
    $("srcInfo").textContent = "—";
    setMessage(`Cannot read this file: ${error.message}`, "err");
    runButton.disabled = true;
  }
});

// ---- packaging ------------------------------------------------------------

runButton.addEventListener("click", async () => {
  if (!chosen) return;

  runButton.disabled = true;
  $("statusPanel").hidden = false;
  $("outputPanel").hidden = true;
  $("playerPanel").hidden = true;
  $("files").innerHTML = "";
  setMessage("Packaging…");

  const started = performance.now();
  const produced = new Map(); // name -> Blob
  let bytes = 0;

  const queue = new HlsQueue({
    segmentDuration: Number($("segdur").value) || 6,
    // "Upload" straight into memory so the demo needs no backend at all.
    upload: async (item) => {
      produced.set(item.name, item.blob);
      bytes += item.blob.size;
      addFileRow(item);
      $("segCount").textContent = String(
        [...produced.keys()].filter((n) => n.endsWith(".m4s")).length,
      );
      $("outSize").textContent = formatBytes(bytes);
      $("elapsed").textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
    },
    onProgress: ({ percent }) => {
      $("progress").value = percent;
    },
  });

  queue.add(chosen);
  const report = await queue.drain();

  $("progress").value = 100;
  $("elapsed").textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;

  if (report.failed.length > 0) {
    setMessage(`Failed: ${report.failed[0].error.message}`, "err");
    runButton.disabled = false;
    return;
  }

  const job = report.succeeded[0];
  setMessage(`Done — ${produced.size} files in ${((performance.now() - started) / 1000).toFixed(1)}s.`, "ok");

  $("outputPanel").hidden = false;
  $("playlist").textContent = await produced.get(job.masterPlaylist).text();

  play(produced, job.masterPlaylist);
  runButton.disabled = false;
});

// ---- playback -------------------------------------------------------------

/**
 * Play the in-memory output.
 *
 * hls.js fetches by URL, so each output file is exposed as a blob: URL and the
 * playlist is rewritten to point at them. That is a demo convenience — real
 * output uses relative URLs and works unmodified on any storage.
 */
async function play(produced, playlistName) {
  const urls = new Map();
  for (const [name, blob] of produced) urls.set(name, URL.createObjectURL(blob));

  let playlist = await produced.get(playlistName).text();
  for (const [name, url] of urls) {
    playlist = playlist.replaceAll(name, url);
  }
  const playlistUrl = URL.createObjectURL(
    new Blob([playlist], { type: "application/vnd.apple.mpegurl" }),
  );

  const video = $("player");
  $("playerPanel").hidden = false;

  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(playlistUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) setMessage(`Playback error: ${data.details}`, "err");
    });
  } else {
    // Safari plays HLS natively.
    video.src = playlistUrl;
  }
}

// ---- small helpers --------------------------------------------------------

function addFileRow(item) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><code>${escapeHtml(item.name)}</code></td>
    <td>${item.isManifest ? "playlist" : item.name.endsWith("init.mp4") ? "init" : "segment"}</td>
    <td class="num">${formatBytes(item.blob.size)}</td>`;
  $("files").appendChild(row);
  $("outputPanel").hidden = false;
}

function setMessage(text, kind = "") {
  const el = $("message");
  el.textContent = text;
  el.className = kind;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 && u > 0 ? 1 : 0)} ${units[u]}`;
}
