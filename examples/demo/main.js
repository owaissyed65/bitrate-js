/**
 * Feature demo for bitrate.
 *
 * Each panel drives the real library in this tab. Nothing is uploaded; output is
 * held in memory and served to hls.js through blob: URLs.
 */

import * as bitrate from "bitrate-js";
import Hls from "hls.js";

const {
  HlsQueue,
  JobStore,
  isSupported,
  isTranscodeSupported,
  inspect,
  remux,
  transcode,
  packageFrames,
  planLadder,
  assertSafeKey,
  isStorageAvailable,
  checkQuota,
} = bitrate;

// Exposed so the library can be exercised from the devtools console.
window.bitrate = bitrate;

const $ = (id) => document.getElementById(id);

// ---- tiny logging helper --------------------------------------------------

function logger(id) {
  const el = $(id);
  el.textContent = "";
  return {
    line(text, cls = "") {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = `${text}\n`;
      el.appendChild(span);
      el.scrollTop = el.scrollHeight;
    },
    head(text) {
      this.line(text, "hd");
    },
    ok(text) {
      this.line(`✓ ${text}`, "ok");
    },
    err(text) {
      this.line(`✗ ${text}`, "err");
    },
    warn(text) {
      this.line(`! ${text}`, "warn");
    },
  };
}

const fmtBytes = (n) => {
  const u = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

/** Play an in-memory HLS output. */
function playInMemory(videoEl, produced, playlistName) {
  const urls = new Map();
  for (const [name, blob] of produced) urls.set(name, URL.createObjectURL(blob));

  let playlist = produced.get(playlistName).text
    ? null
    : null;

  return produced
    .get(playlistName)
    .text()
    .then((text) => {
      // A master playlist points at media playlists, which point at segments —
      // rewrite both levels so hls.js can fetch blob: URLs.
      for (const [name, blob] of produced) {
        if (name.endsWith(".m3u8") && name !== playlistName) {
          // Rewrite the child playlist first, then republish it as a blob.
          void blob;
        }
      }
      return text;
    })
    .then(async (text) => {
      const rewritten = new Map();
      for (const [name, blob] of produced) {
        if (name.endsWith(".m3u8")) {
          let child = await blob.text();
          for (const [n, u] of urls) child = child.replaceAll(n, u);
          rewritten.set(name, URL.createObjectURL(new Blob([child], { type: "application/vnd.apple.mpegurl" })));
        }
      }
      let master = text;
      for (const [n, u] of rewritten) master = master.replaceAll(n, u);
      for (const [n, u] of urls) if (!n.endsWith(".m3u8")) master = master.replaceAll(n, u);

      const url = URL.createObjectURL(new Blob([master], { type: "application/vnd.apple.mpegurl" }));
      videoEl.hidden = false;

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        return hls;
      }
      videoEl.src = url;
      return null;
    });
}

// ---- 1. capabilities ------------------------------------------------------

(function capabilities() {
  const support = isSupported();
  const log = logger("capsOut");

  const badges = [
    ["remux", support.remux],
    ["transcode", support.transcode],
    ["resume", support.resume],
    ["seamless resume", support.seamlessResume],
  ];
  $("caps").innerHTML = badges
    .map(([name, on]) => `<span class="badge ${on ? "y" : "n"}">${name} ${on ? "✓" : "✗"}</span>`)
    .join("");

  log.head("isSupported()");
  for (const [name, on] of badges) log.line(`  ${name}: ${on}`);
  for (const reason of support.reasons) log.warn(reason);

  checkQuota().then((q) => {
    log.head("storage");
    log.line(`  IndexedDB: ${isStorageAvailable()}`);
    if (q.quota) {
      log.line(`  quota: ${fmtBytes(q.quota)}, used: ${fmtBytes(q.usage ?? 0)}, free: ${fmtBytes(q.available ?? 0)}`);
    }
    log.line(`  persisted (exempt from eviction): ${q.persisted}`);
  });

  if (!support.transcode) $("abrRun").disabled = true;
})();

// ---- 2. remux -------------------------------------------------------------

async function runRemux(file, label) {
  const log = logger("remuxOut");
  $("remuxStats").hidden = false;
  $("remuxProg").hidden = false;
  $("remuxProg").value = 0;

  log.head(`remux — ${label}`);
  try {
    const info = await inspect(file);
    $("rxSrc").textContent = `${info.width}×${info.height}, ${info.duration.toFixed(1)}s`;
    log.line(`  source: ${info.width}×${info.height}, ${info.sampleCount} frames, ${info.duration.toFixed(1)}s`);
  } catch (error) {
    log.err(`cannot read this file: ${error.message}`);
    return;
  }

  const produced = new Map();
  let bytes = 0;
  const t0 = performance.now();

  try {
    for await (const out of remux(file, {
      prefix: "demo",
      segmentDuration: Number($("remuxDur").value) || 6,
      onProgress: ({ fraction }) => ($("remuxProg").value = fraction * 100),
    })) {
      produced.set(out.name, out.blob);
      bytes += out.blob.size;
      $("rxSeg").textContent = String([...produced.keys()].filter((n) => n.endsWith(".m4s")).length);
      $("rxSize").textContent = fmtBytes(bytes);
    }
  } catch (error) {
    log.err(error.message);
    return;
  }

  const ms = performance.now() - t0;
  $("remuxProg").value = 100;
  $("rxTime").textContent = `${ms.toFixed(0)} ms`;

  log.ok(`${produced.size} files, ${fmtBytes(bytes)}, in ${ms.toFixed(0)} ms`);
  for (const [name, blob] of produced) log.line(`  ${name}  ${fmtBytes(blob.size)}`);

  const playlist = [...produced.keys()].find((n) => n.endsWith(".m3u8"));
  log.head("playlist");
  log.line(
    (await produced.get(playlist).text())
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
}

$("remuxSample").addEventListener("click", async () => {
  const res = await fetch("/sample.mp4");
  const blob = await res.blob();
  await runRemux(new File([blob], "sample.mp4", { type: "video/mp4" }), "generated sample");
});

$("remuxFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) runRemux(file, file.name);
});

// ---- 3. packageFrames -----------------------------------------------------

$("framesRun").addEventListener("click", async () => {
  const log = logger("framesOut");
  const button = $("framesRun");
  button.disabled = true;
  $("framesProg").hidden = false;
  $("framesProg").value = 0;

  const heights = $("framesLadder").value.split(",").map(Number);
  const ladder = heights.map((h) => ({ height: h, bitrate: h >= 240 ? 600_000 : 300_000 }));

  log.head("packageFrames() — canvas → WebCodecs H.264 → fMP4 → HLS");
  log.line(`  ladder: ${heights.map((h) => `${h}p`).join(", ")}`);

  const TOTAL = 90; // 3s @ 30fps
  async function* frames() {
    const canvas = new OffscreenCanvas(320, 240);
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < TOTAL; i++) {
      ctx.fillStyle = `hsl(${(i * 4) % 360} 70% 45%)`;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 64px sans-serif";
      ctx.fillText(String(i), 24, 140);
      $("framesProg").value = (i / TOTAL) * 100;
      yield new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / 30),
        duration: Math.round(1e6 / 30),
      });
    }
  }

  const produced = new Map();
  const t0 = performance.now();
  try {
    for await (const out of packageFrames(frames(), {
      prefix: "canvas",
      segmentDuration: 1,
      ladder,
    })) {
      produced.set(out.name, out.blob);
    }
  } catch (error) {
    log.err(error.message);
    button.disabled = false;
    return;
  }

  $("framesProg").value = 100;
  log.ok(`${produced.size} files in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const [name, blob] of produced) log.line(`  ${name}  ${fmtBytes(blob.size)}`);

  const master = [...produced.keys()].find((n) => n.includes("master")) ?? [...produced.keys()].find((n) => n.endsWith(".m3u8"));
  const video = $("framesVideo");
  await playInMemory(video, produced, master);

  // Confirm the browser actually decoded it, rather than just accepting the container.
  const t1 = performance.now();
  while (!Number.isFinite(video.duration) && performance.now() - t1 < 8000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  video.currentTime = 2.4;
  await new Promise((r) => setTimeout(r, 900));

  log.head("playback check");
  log.line(`  duration: ${video.duration?.toFixed(2)}s   size: ${video.videoWidth}×${video.videoHeight}`);
  log.line(`  readyState: ${video.readyState} (4 = enough data)`);
  log.line(`  buffered: ${video.buffered.length ? `${video.buffered.start(0).toFixed(1)}–${video.buffered.end(video.buffered.length - 1).toFixed(1)}s` : "none"}`);
  if (video.error) log.err(`media error: ${video.error.message || video.error.code}`);
  else if (video.readyState >= 3) log.ok(`decoded and seeked to ${video.currentTime.toFixed(1)}s — frame ${Math.round(video.currentTime * 30)} on screen`);

  button.disabled = false;
});

// ---- 3b. audio ------------------------------------------------------------

async function runAudio(file, label) {
  const log = logger("audioOut");
  log.head(`audio — ${label}`);

  let info;
  try {
    info = await inspect(file);
  } catch (error) {
    log.err(`cannot read this file: ${error.message}`);
    return;
  }

  log.line(`  video: ${info.width}×${info.height}, ${info.sampleCount} frames, ${info.duration.toFixed(1)}s`);
  if (!info.hasAudio) {
    log.warn("this source has no audio track — output will be video only");
  } else {
    log.ok(`audio: ${info.audioSampleCount} frames at ${info.audioTimescale} Hz`);
  }

  const produced = new Map();
  const t0 = performance.now();
  try {
    for await (const out of remux(file, { prefix: "av", segmentDuration: 4 })) {
      produced.set(out.name, out.blob);
    }
  } catch (error) {
    log.err(error.message);
    return;
  }
  log.line(`  packaged ${produced.size} files in ${(performance.now() - t0).toFixed(0)} ms`);

  // Inspect the output structure directly, so the claim is checked not asserted.
  const init = new Uint8Array(await produced.get("av_init.mp4").arrayBuffer());
  const moov = childBox(init, "moov");
  const trackCount = listBoxes(moov).filter((b) => b.kind === "trak").length;
  log.head("output structure");
  log.line(`  tracks in moov: ${trackCount}`);

  const firstSegment = [...produced.keys()].find((n) => n.endsWith(".m4s"));
  const segBytes = new Uint8Array(await produced.get(firstSegment).arrayBuffer());
  const runs = listBoxes(childBox(segBytes, "moof")).filter((b) => b.kind === "traf");
  log.line(`  traf boxes per segment: ${runs.length}`);
  for (const run of runs) {
    const id = readU32(childBox(run.payload, "tfhd"), 4);
    const count = readU32(childBox(run.payload, "trun"), 4);
    log.line(`    track ${id}: ${count} samples`);
  }

  if (info.hasAudio && trackCount === 2 && runs.length === 2) {
    log.ok("audio survived: two tracks in the init segment and in every fragment");
  } else if (!info.hasAudio && trackCount === 1) {
    log.ok("silent source produced a correct single-track output");
  } else {
    log.err("unexpected track layout");
  }

  // Let the browser judge whether the result is really playable.
  log.head("playback check");
  const video = document.createElement("video");
  video.muted = true;
  await playInMemory(video, produced, [...produced.keys()].find((n) => n.endsWith(".m3u8")));
  const t1 = performance.now();
  while (!Number.isFinite(video.duration) && performance.now() - t1 < 6000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (video.error) {
    log.warn(`decoder rejected the media: ${video.error.message || video.error.code}`);
    log.line("  expected for a generated sample — its frames are not real H.264/AAC");
  }
  log.line(`  duration reported by the player: ${video.duration?.toFixed?.(2) ?? "n/a"}s`);
}

$("audioRun").addEventListener("click", async () => {
  const blob = await (await fetch("/sample-audio.mp4")).blob();
  await runAudio(new File([blob], "sample-audio.mp4", { type: "video/mp4" }), "generated sample with audio");
});

$("audioFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) runAudio(file, file.name);
});

// ---- box reading, for the checks above ------------------------------------

function listBoxes(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let at = 0;
  while (at + 8 <= buf.byteLength) {
    const size = view.getUint32(at);
    if (size < 8) break;
    const kind = String.fromCharCode(
      view.getUint8(at + 4), view.getUint8(at + 5),
      view.getUint8(at + 6), view.getUint8(at + 7),
    );
    out.push({ kind, payload: buf.subarray(at + 8, Math.min(at + size, buf.byteLength)) });
    at += size;
  }
  return out;
}

function childBox(buf, kind) {
  const found = listBoxes(buf).find((b) => b.kind === kind);
  if (!found) throw new Error(`box '${kind}' not found`);
  return found.payload;
}

function readU32(buf, at) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(at);
}

// ---- 4. transcode ---------------------------------------------------------

$("abrFile").addEventListener("change", (e) => {
  $("abrRun").disabled = !e.target.files?.[0] || !isTranscodeSupported();
});

$("abrRun").addEventListener("click", async () => {
  const file = $("abrFile").files?.[0];
  if (!file) return;

  const log = logger("abrOut");
  $("abrRun").disabled = true;
  $("abrProg").hidden = false;

  log.head(`transcode — ${file.name}`);
  try {
    const info = await inspect(file);
    log.line(`  source: ${info.width}×${info.height}, ${info.duration.toFixed(1)}s`);
    const plan = planLadder(bitrate.DEFAULT_LADDER, info.width, info.height);
    log.line(`  ladder (no upscaling): ${plan.map((r) => `${r.width}×${r.height}@${(r.bitrate / 1e6).toFixed(1)}M`).join(", ")}`);
  } catch (error) {
    log.err(error.message);
    $("abrRun").disabled = false;
    return;
  }

  const produced = new Map();
  const t0 = performance.now();
  try {
    for await (const out of transcode(file, {
      prefix: "abr",
      segmentDuration: 4,
      onProgress: ({ fraction }) => ($("abrProg").value = fraction * 100),
    })) {
      produced.set(out.name, out.blob);
      log.line(`  + ${out.name} (${fmtBytes(out.blob.size)})`);
    }
  } catch (error) {
    log.err(error.message);
    log.warn("A source with synthetic frames cannot be decoded — use a real recording.");
    $("abrRun").disabled = false;
    return;
  }

  $("abrProg").value = 100;
  log.ok(`${produced.size} files in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const master = [...produced.keys()].find((n) => n.includes("master"));
  if (master) {
    log.head("master playlist");
    log.line((await produced.get(master).text()).split("\n").map((l) => `  ${l}`).join("\n"));
    await playInMemory($("abrVideo"), produced, master);
  }
  $("abrRun").disabled = false;
});

// ---- 5. queue -------------------------------------------------------------

$("queueRun").addEventListener("click", async () => {
  const log = logger("queueOut");
  const button = $("queueRun");
  button.disabled = true;
  $("queueProg").hidden = false;

  const sample = await (await fetch("/sample.mp4")).blob();
  const good1 = new File([sample], "holiday.mp4", { type: "video/mp4" });
  const good2 = new File([sample], "wedding.mp4", { type: "video/mp4" });
  const bad = new File([new Uint8Array(4096).fill(7)], "corrupt.mp4", { type: "video/mp4" });

  const flaky = $("queueFlaky").checked;
  let attempts = 0;
  const uploaded = [];

  log.head("queue: holiday.mp4, corrupt.mp4, wedding.mp4");
  if (flaky) log.line("  uploads fail ~40% of the time to exercise retries");

  const q = new HlsQueue({
    segmentDuration: 6,
    concurrency: 1,
    retries: flaky ? 4 : 2,
    upload: async (item) => {
      attempts++;
      if (flaky && Math.random() < 0.4) throw new Error("simulated network blip");
      uploaded.push(item.name);
    },
    onProgress: ({ percent }) => ($("queueProg").value = percent),
    onJobDone: ({ jobId, files }) => log.ok(`${jobId} finished — ${files.length} files`),
    onJobError: ({ jobId, error }) => log.err(`${jobId} failed — ${error.message}`),
  });

  q.add([good1, bad, good2]);
  const report = await q.drain();

  log.head("drain() report");
  log.line(`  succeeded: ${report.succeeded.length}`);
  log.line(`  failed:    ${report.failed.length}`);
  log.line(`  uploaded:  ${uploaded.length} files in ${attempts} attempts${flaky ? " (extras are retries)" : ""}`);
  if (report.succeeded.length === 2 && report.failed.length === 1) {
    log.ok("one bad file was recorded and skipped; the batch still completed");
  }
  log.head("job states");
  for (const job of q.jobs) log.line(`  ${job.fileName.padEnd(14)} ${job.status}`);

  button.disabled = false;
});

// ---- 6. resume ------------------------------------------------------------

$("resumeRun").addEventListener("click", async () => {
  const log = logger("resumeOut");
  const button = $("resumeRun");
  button.disabled = true;

  const sample = await (await fetch("/sample.mp4")).blob();
  const file = new File([sample], "long-video.mp4", { type: "video/mp4", lastModified: 1700000000000 });
  const store = await JobStore.open();

  // Reference: what an uninterrupted run produces.
  const whole = [];
  for await (const out of remux(file, { prefix: "ref", segmentDuration: 2 })) {
    if (out.name.endsWith(".m4s")) whole.push(out.blob.size);
  }

  log.head("session 1 — interrupted partway");
  let firstQueue;
  const uploaded1 = [];
  firstQueue = new HlsQueue({
    segmentDuration: 2,
    store,
    upload: async (item) => {
      uploaded1.push(item.name);
      if (uploaded1.filter((n) => n.endsWith(".m4s")).length >= 5) firstQueue.cancel();
    },
  });
  firstQueue.add(file);
  const report1 = await firstQueue.drain();
  log.line(`  uploaded ${uploaded1.filter((n) => n.endsWith(".m4s")).length} segments, then the tab "closed"`);
  log.line(`  succeeded: ${report1.succeeded.length}, failed/cancelled: ${report1.failed.length}`);

  const interrupted = await store.resumableJobs();
  if (interrupted.length === 0) {
    log.err("nothing was checkpointed — resume is not possible");
    button.disabled = false;
    return;
  }
  const job = interrupted[0];
  log.ok(`checkpoint found: ${job.completedSegmentDurations.length} segments, ${job.samplesProcessed} frames done`);

  log.head("session 2 — user reopens and re-picks the file");
  const uploaded2 = [];
  const second = new HlsQueue({
    segmentDuration: 2,
    store,
    upload: async (item) => uploaded2.push(item.name),
  });
  second.addResume({ stored: job, file });
  const report2 = await second.drain();

  const newSegments = uploaded2.filter((n) => n.endsWith(".m4s")).length;
  log.line(`  produced ${newSegments} further segments (not redoing the first ${job.completedSegmentDurations.length})`);
  log.line(`  total segments: ${job.completedSegmentDurations.length + newSegments} vs ${whole.length} uninterrupted`);

  if (report2.succeeded.length === 1) log.ok("job completed after the interruption");
  if (job.completedSegmentDurations.length + newSegments === whole.length) {
    log.ok("segment count matches an uninterrupted run — no work lost or repeated");
  } else {
    log.warn("segment count differs from the reference run");
  }

  log.head("wrong-file protection");
  try {
    second.addResume({ stored: job, file: new File([new Uint8Array(10)], "other.mp4") });
    log.err("a mismatched file was accepted — that would splice two videos");
  } catch (error) {
    log.ok(`mismatched file rejected: ${error.message.slice(0, 70)}…`);
  }

  log.head("cleanup");
  log.line(`  stored jobs remaining: ${(await store.resumableJobs()).length} (deleted once uploaded)`);
  store.close();
  button.disabled = false;
});

$("resumeClear").addEventListener("click", async () => {
  const store = await JobStore.open();
  await store.clear();
  store.close();
  logger("resumeOut").ok("stored jobs cleared");
});

// ---- 7. upload adapters ---------------------------------------------------

$("adapterRun").addEventListener("click", async () => {
  const log = logger("adapterOut");
  const sample = await (await fetch("/sample.mp4")).blob();
  const file = new File([sample], "clip.mp4", { type: "video/mp4" });

  log.head("what your upload adapter receives");
  log.line("  every backend gets the same shape — { jobId, name, blob, contentType, isManifest }");
  log.line("");

  const rows = [];
  const q = new HlsQueue({
    segmentDuration: 8,
    upload: async (item) => {
      rows.push(item);
      log.line(
        `  ${item.name.padEnd(26)} ${item.contentType.padEnd(32)} ${fmtBytes(item.blob.size).padStart(8)}  ${item.isManifest ? "manifest" : "segment"}`,
      );
    },
  });
  q.add(file);
  await q.drain();

  log.line("");
  log.head("how the presets would store these");
  const first = rows.find((r) => !r.isManifest);
  log.line(`  s3Adapter({ bucket: "videos", prefix: "hls" })`);
  log.line(`     → PutObject  Key="hls/${first.name}"  ContentType="${first.contentType}"`);
  log.line(`     → CacheControl: immutable for segments, short for playlists`);
  log.line(`  supabaseAdapter({ bucket: "videos", prefix: "hls" })`);
  log.line(`     → storage.from("videos").upload("hls/${first.name}", blob, { upsert: true })`);
  log.line(`  appwriteAdapter({ bucketId: "videos" })`);
  log.line(`     → createFile("videos", "${first.name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 24)}…", file)`);
  log.line("");
  log.ok(`${rows.length} files — same contract for S3, Supabase, Appwrite, or your own fetch()`);
});

// ---- 8. security ----------------------------------------------------------

$("secRun").addEventListener("click", async () => {
  const log = logger("secOut");

  log.head("1. object keys cannot escape their prefix");
  for (const evil of ["../../etc/passwd", "/absolute", "a/../../b", "back\\slash"]) {
    try {
      assertSafeKey(evil);
      log.err(`accepted ${JSON.stringify(evil)}`);
    } catch {
      log.ok(`rejected ${JSON.stringify(evil)}`);
    }
  }

  log.head("2. hostile file names never reach storage keys");
  const evilFile = new File([await (await fetch("/sample.mp4")).blob()], "../../../etc/passwd.mp4", {
    type: "video/mp4",
  });
  const names = [];
  const q = new HlsQueue({ segmentDuration: 30, upload: async (i) => names.push(i.name) });
  q.add(evilFile);
  await q.drain();
  const leaked = names.filter((n) => n.includes("..") || n.includes("passwd"));
  if (leaked.length === 0) log.ok(`ids are random, not derived from the name — e.g. ${names[0]}`);
  else log.err(`leaked: ${leaked.join(", ")}`);

  log.head("3. malformed input is rejected, never crashes the page");
  for (const [label, bytes] of [
    ["random bytes", new Uint8Array(512).map(() => Math.random() * 256)],
    ["empty file", new Uint8Array(0)],
    ["truncated header", new Uint8Array([0, 0, 0, 200, 109, 111, 111, 118])],
  ]) {
    try {
      await inspect(new Blob([bytes]));
      log.err(`${label} was accepted`);
    } catch (error) {
      log.ok(`${label} → ${error.message.slice(0, 58)}…`);
    }
  }

  log.head("4. the library makes no network requests of its own");
  log.line("  no telemetry, no CDN fetches — the only traffic is your upload adapter");

  log.head("5. no adapter accepts credentials");
  log.line("  s3Adapter takes an authenticated client, never accessKeyId/secretAccessKey");
  log.line("  supabaseAdapter expects the anon key + RLS; never service_role");
  log.line("  presignedAdapter redacts signatures from error messages");
});
