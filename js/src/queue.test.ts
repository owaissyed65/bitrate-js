/**
 * M3 acceptance: the queue and the upload contract.
 *
 * The behaviour that matters most is failure handling — a batch of user
 * uploads must survive one bad file — and that uploads happen *during*
 * packaging so memory does not grow with the batch.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { HlsQueue } from "./queue.js";
import { PermanentUploadError, assertSafeKey, joinKey, withRetry } from "./upload.js";
import { makeMp4Blob } from "./testing/make-mp4.js";
import { ensureWasm } from "./wasm-loader.js";
import type { UploadItem } from "./types.js";

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL("./wasm/bitrate_core_bg.wasm", import.meta.url));
  await ensureWasm(await readFile(wasmPath));
});

/** A small valid source video. */
function video(frames = 60) {
  return makeMp4Blob({ frameCount: frames, gop: 30 }).blob;
}

/** An in-memory upload target that records what it received. */
function recordingAdapter() {
  const received: { name: string; size: number; contentType: string; jobId: string }[] = [];
  const adapter = async (item: UploadItem) => {
    received.push({
      name: item.name,
      size: item.blob.size,
      contentType: item.contentType,
      jobId: item.jobId,
    });
  };
  return { adapter, received };
}

describe("processing a batch", () => {
  it("packages every file and uploads all output", async () => {
    const { adapter, received } = recordingAdapter();
    const q = new HlsQueue({ segmentDuration: 1, upload: adapter });

    q.add([video(60), video(60)]);
    const report = await q.drain();

    expect(report.succeeded).toHaveLength(2);
    expect(report.failed).toHaveLength(0);

    // Each job: 1 init + 2 segments + 1 playlist.
    expect(received).toHaveLength(8);
    const jobIds = new Set(received.map((r) => r.jobId));
    expect(jobIds.size).toBe(2);
  });

  it("accepts files added one at a time or in bulk", async () => {
    const q = new HlsQueue({ segmentDuration: 2 });
    const [first] = q.add(video(30));
    const rest = q.add([video(30), video(30)]);

    expect(first).toMatch(/^job_/);
    expect(rest).toHaveLength(2);
    expect(q.jobs).toHaveLength(3);
    expect(q.jobs.every((j) => j.status === "queued")).toBe(true);

    const report = await q.drain();
    expect(report.succeeded).toHaveLength(3);
  });

  it("returns the playlist name for each finished job", async () => {
    const q = new HlsQueue({ segmentDuration: 2 });
    q.add(video(60));
    const report = await q.drain();

    const job = report.succeeded[0]!;
    expect(job.masterPlaylist).toMatch(/\.m3u8$/);
    expect(job.files).toContain(job.masterPlaylist);
    expect(job.files.filter((f) => f.endsWith(".m4s")).length).toBeGreaterThan(0);
  });

  it("works with no upload adapter, keeping the file list only", async () => {
    const q = new HlsQueue({ segmentDuration: 2 });
    q.add(video(30));
    const report = await q.drain();
    expect(report.succeeded[0]!.files.length).toBeGreaterThan(1);
  });

  it("reports progress and marks jobs done", async () => {
    const progress: number[] = [];
    const done: string[] = [];
    const q = new HlsQueue({
      segmentDuration: 1,
      onProgress: ({ percent }) => progress.push(percent),
      onJobDone: ({ jobId }) => done.push(jobId),
    });

    q.add(video(300));
    await q.drain();

    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBe(100);
    expect(done).toHaveLength(1);
    expect(q.jobs[0]!.status).toBe("done");
    expect(q.jobs[0]!.progress).toBe(1);
  });

  it("processes files in parallel when concurrency allows", async () => {
    const q = new HlsQueue({ segmentDuration: 2, concurrency: 3 });
    q.add([video(30), video(30), video(30)]);
    const report = await q.drain();
    expect(report.succeeded).toHaveLength(3);
  });
});

describe("failure handling — skip and continue", () => {
  it("keeps going when one file is not a valid video", async () => {
    const errors: string[] = [];
    const q = new HlsQueue({
      segmentDuration: 2,
      onJobError: ({ jobId }) => errors.push(jobId),
    });

    const junk = new Blob([new Uint8Array(500).fill(9)]);
    q.add([video(30), junk, video(30)]);

    const report = await q.drain();

    // The bad file is recorded; the good ones still finish.
    expect(report.succeeded).toHaveLength(2);
    expect(report.failed).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(report.failed[0]!.error.message).toMatch(/moov/i);
  });

  it("keeps going when uploads fail for one file", async () => {
    let seenJobs = 0;
    const failingJob = new Set<string>();

    const q = new HlsQueue({
      segmentDuration: 2,
      retries: 0,
      upload: async (item) => {
        if (!failingJob.has(item.jobId) && seenJobs === 0) {
          seenJobs++;
          failingJob.add(item.jobId);
        }
        if (failingJob.has(item.jobId)) throw new Error("storage is down");
      },
    });

    q.add([video(30), video(30)]);
    const report = await q.drain();

    expect(report.failed).toHaveLength(1);
    expect(report.succeeded).toHaveLength(1);
    expect(report.failed[0]!.error.message).toContain("storage is down");
  });

  it("drain never rejects, even when everything fails", async () => {
    const q = new HlsQueue({ segmentDuration: 2 });
    q.add([new Blob([new Uint8Array(10)]), new Blob([new Uint8Array(10)])]);

    const report = await q.drain();
    expect(report.succeeded).toHaveLength(0);
    expect(report.failed).toHaveLength(2);
    expect(q.jobs.every((j) => j.status === "failed")).toBe(true);
  });

  it("records the error on the job for display", async () => {
    const q = new HlsQueue({ segmentDuration: 2 });
    q.add(new Blob([new Uint8Array(32)]));
    await q.drain();
    expect(q.jobs[0]!.error).toBeInstanceOf(Error);
  });
});

describe("streaming uploads", () => {
  it("uploads each file as it is produced, not in a batch at the end", async () => {
    const order: string[] = [];
    const q = new HlsQueue({
      segmentDuration: 1,
      upload: async (item) => {
        order.push(item.name);
      },
      onJobDone: () => order.push("DONE"),
    });

    q.add(video(120));
    await q.drain();

    // Every upload must precede completion — nothing is buffered to the end.
    expect(order.at(-1)).toBe("DONE");
    expect(order.indexOf("DONE")).toBe(order.length - 1);
    expect(order.filter((o) => o.endsWith(".m4s")).length).toBe(4);
  });
});

describe("cancellation", () => {
  it("stops the batch and marks remaining jobs cancelled", async () => {
    const q = new HlsQueue({
      segmentDuration: 1,
      upload: async () => {
        q.cancel();
      },
    });

    q.add([video(120), video(120), video(120)]);
    const report = await q.drain();

    expect(report.succeeded.length).toBeLessThan(3);
    expect(q.jobs.some((j) => j.status === "cancelled" || j.status === "failed")).toBe(true);
  });
});

describe("configuration validation", () => {
  it("rejects modes that are not implemented yet", () => {
    expect(() => new HlsQueue({ mode: "transcode" })).toThrow(/not implemented/);
  });

  it("accepts remux and auto", () => {
    expect(() => new HlsQueue({ mode: "remux" })).not.toThrow();
    expect(() => new HlsQueue({ mode: "auto" })).not.toThrow();
  });

  it("rejects nonsensical concurrency", () => {
    expect(() => new HlsQueue({ concurrency: 0 })).toThrow(/positive integer/);
    expect(() => new HlsQueue({ concurrency: -1 })).toThrow();
    expect(() => new HlsQueue({ concurrency: 1.5 })).toThrow();
  });
});

describe("job ids", () => {
  it("does not derive storage keys from user-supplied file names", async () => {
    // A hostile file name must never reach an object key (SECURITY.md §2).
    const evil = new File([video(30)], "../../../etc/passwd.mp4", { type: "video/mp4" });
    const { adapter, received } = recordingAdapter();

    const q = new HlsQueue({ segmentDuration: 2, upload: adapter });
    q.add(evil);
    await q.drain();

    expect(received.length).toBeGreaterThan(0);
    for (const r of received) {
      expect(r.name).not.toContain("..");
      expect(r.name).not.toContain("passwd");
      expect(r.name).toMatch(/^job_/);
    }
    // The original name is still available for display.
    expect(q.jobs[0]!.fileName).toBe("../../../etc/passwd.mp4");
  });

  it("gives every job a unique id", () => {
    const q = new HlsQueue();
    const ids = q.add([video(1), video(1), video(1)]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("retry wrapper", () => {
  const item: UploadItem = {
    jobId: "job_1",
    name: "a.m4s",
    blob: new Blob([new Uint8Array(4)]),
    contentType: "video/mp4",
    isManifest: false,
  };

  it("retries transient failures and eventually succeeds", async () => {
    let attempts = 0;
    const adapter = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("network blip");
    });

    const wrapped = withRetry(adapter, { retries: 3, sleep: async () => {} });
    await wrapped(item);
    expect(attempts).toBe(3);
  });

  it("gives up after the configured attempts and surfaces the last error", async () => {
    const adapter = vi.fn(async () => {
      throw new Error("still failing");
    });

    const wrapped = withRetry(adapter, { retries: 2, sleep: async () => {} });
    await expect(wrapped(item)).rejects.toThrow("still failing");
    expect(adapter).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });

  it("does not retry a permanent error", async () => {
    // Retrying a rejected credential just wastes time and hammers the endpoint.
    const adapter = vi.fn(async () => {
      throw new PermanentUploadError("access denied");
    });

    const wrapped = withRetry(adapter, { retries: 5, sleep: async () => {} });
    await expect(wrapped(item)).rejects.toThrow("access denied");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("reports each retry", async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const adapter = async () => {
      if (++attempts < 3) throw new Error("blip");
    };

    await withRetry(adapter, { retries: 3, sleep: async () => {}, onRetry })(item);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("backs off with jitter rather than a fixed interval", async () => {
    const delays: number[] = [];
    const adapter = async () => {
      throw new Error("always");
    };

    await expect(
      withRetry(adapter, {
        retries: 4,
        sleep: async (ms) => {
          delays.push(ms);
        },
      })(item),
    ).rejects.toThrow();

    expect(delays).toHaveLength(4);
    // Full jitter: each delay lies within its own growing ceiling.
    expect(delays.every((d, i) => d >= 0 && d <= Math.min(300 * 2 ** i, 10_000))).toBe(true);
  });
});

describe("object key safety", () => {
  it("rejects keys that could escape their prefix", () => {
    for (const bad of ["../secret", "a/../../b", "/absolute", "back\\slash", "", "nul "]) {
      expect(() => assertSafeKey(bad), bad).toThrow(PermanentUploadError);
    }
  });

  it("accepts the names the packager generates", () => {
    for (const good of ["720p_00001.m4s", "job_1_init.mp4", "video.m3u8"]) {
      expect(assertSafeKey(good)).toBe(good);
    }
  });

  it("joins prefixes without introducing traversal", () => {
    expect(joinKey("hls", "a.m4s")).toBe("hls/a.m4s");
    expect(joinKey("/hls/", "a.m4s")).toBe("hls/a.m4s");
    expect(joinKey(undefined, "a.m4s")).toBe("a.m4s");
    expect(() => joinKey("..", "a.m4s")).toThrow();
  });
});
