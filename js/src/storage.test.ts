/**
 * M4 acceptance: resume persistence.
 *
 * The point of this store is that a user who closes the tab 40 minutes into a
 * job does not start over. These tests cover what that requires: progress
 * survives, pending uploads are recoverable, a re-picked file is verified, and
 * finished jobs leave nothing behind.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  JobStore,
  assertRoomFor,
  checkQuota,
  isStorageAvailable,
  matchesJob,
  requestPersistence,
  type StoredJob,
} from "./storage.js";

let dbCounter = 0;
/** A fresh database per test, so state cannot leak between them. */
const freshStore = () => JobStore.open(`bitrate-test-${dbCounter++}`);

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    jobId: "job_1",
    fileName: "holiday.mp4",
    fileSize: 1_048_576,
    lastModified: 1_700_000_000_000,
    settings: { prefix: "job_1", segmentDuration: 6 },
    status: "processing",
    lastCompletedSegment: -1,
    samplesProcessed: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("availability", () => {
  it("detects IndexedDB", () => {
    expect(isStorageAvailable()).toBe(true);
  });
});

describe("job persistence", () => {
  let store: JobStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("round-trips a job", async () => {
    await store.putJob(job());
    const loaded = await store.getJob("job_1");
    expect(loaded).toMatchObject({ jobId: "job_1", fileName: "holiday.mp4", status: "processing" });
  });

  it("returns undefined for an unknown job", async () => {
    expect(await store.getJob("nope")).toBeUndefined();
  });

  it("records progress so a resume knows where to restart", async () => {
    await store.putJob(job());
    await store.putJob(job({ lastCompletedSegment: 247, samplesProcessed: 7_410 }));

    const loaded = await store.getJob("job_1");
    expect(loaded!.lastCompletedSegment).toBe(247);
    expect(loaded!.samplesProcessed).toBe(7_410);
  });

  it("stamps updatedAt on every write", async () => {
    await store.putJob(job({ updatedAt: 0 }));
    const loaded = await store.getJob("job_1");
    expect(loaded!.updatedAt).toBeGreaterThan(0);
  });

  it("lists only interrupted jobs, newest first", async () => {
    await store.putJob(job({ jobId: "a", status: "processing" }));
    await new Promise((r) => setTimeout(r, 2));
    await store.putJob(job({ jobId: "b", status: "processing" }));
    await store.putJob(job({ jobId: "c", status: "done" }));

    const resumable = await store.resumableJobs();
    expect(resumable.map((j) => j.jobId)).toEqual(["b", "a"]);
  });
});

describe("pending output", () => {
  let store: JobStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  const segment = (name: string, jobId = "job_1", uploaded = false) => ({
    jobId,
    name,
    blob: new Blob([new Uint8Array([1, 2, 3])]),
    contentType: "video/mp4",
    isManifest: false,
    uploaded,
  });

  it("stores blobs and returns them intact", async () => {
    await store.putSegment(segment("720p_00000.m4s"));
    const pending = await store.pendingSegments("job_1");

    expect(pending).toHaveLength(1);
    // Blob contents must survive; that is the whole point of keeping them.
    expect(new Uint8Array(await pending[0]!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("lists only segments still awaiting upload", async () => {
    await store.putSegment(segment("a.m4s"));
    await store.putSegment(segment("b.m4s", "job_1", true));

    const pending = await store.pendingSegments("job_1");
    expect(pending.map((s) => s.name)).toEqual(["a.m4s"]);
  });

  it("marks a segment uploaded so it is not sent twice", async () => {
    await store.putSegment(segment("a.m4s"));
    await store.markUploaded("job_1", "a.m4s");
    expect(await store.pendingSegments("job_1")).toHaveLength(0);
  });

  it("keeps jobs separate", async () => {
    await store.putSegment(segment("a.m4s", "job_1"));
    await store.putSegment(segment("a.m4s", "job_2"));

    expect(await store.pendingSegments("job_1")).toHaveLength(1);
    expect(await store.pendingSegments("job_2")).toHaveLength(1);
  });

  it("overwrites rather than duplicating on re-put", async () => {
    await store.putSegment(segment("a.m4s"));
    await store.putSegment(segment("a.m4s"));
    expect(await store.pendingSegments("job_1")).toHaveLength(1);
  });

  it("marking an unknown segment is a no-op, not an error", async () => {
    await expect(store.markUploaded("job_1", "ghost.m4s")).resolves.toBeUndefined();
  });
});

describe("cleanup", () => {
  let store: JobStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("deleting a job removes its segments too", async () => {
    await store.putJob(job());
    await store.putSegment({
      jobId: "job_1",
      name: "a.m4s",
      blob: new Blob(["x"]),
      contentType: "video/mp4",
      isManifest: false,
      uploaded: false,
    });

    await store.deleteJob("job_1");

    // Leftover video frames on a shared machine would be a privacy problem.
    expect(await store.getJob("job_1")).toBeUndefined();
    expect(await store.pendingSegments("job_1")).toHaveLength(0);
  });

  it("deleting one job leaves others untouched", async () => {
    await store.putJob(job({ jobId: "keep" }));
    await store.putJob(job({ jobId: "drop" }));
    await store.deleteJob("drop");

    expect(await store.getJob("keep")).toBeDefined();
    expect(await store.getJob("drop")).toBeUndefined();
  });

  it("clear removes everything, for logout", async () => {
    await store.putJob(job({ jobId: "a" }));
    await store.putJob(job({ jobId: "b" }));
    await store.clear();
    expect(await store.resumableJobs()).toHaveLength(0);
  });
});

describe("verifying a re-picked file", () => {
  const stored = job();

  it("accepts the same file", () => {
    const file = new File([new Uint8Array(stored.fileSize)], "holiday.mp4", {
      lastModified: stored.lastModified,
    });
    expect(matchesJob(stored, file)).toBe(true);
  });

  it.each([
    ["a different name", "other.mp4", stored.fileSize, stored.lastModified],
    ["a different size", "holiday.mp4", 99, stored.lastModified],
    ["a different date", "holiday.mp4", stored.fileSize, 1],
  ])("rejects %s", (_label, name, size, lastModified) => {
    // Resuming onto the wrong file would splice two videos together.
    const file = new File([new Uint8Array(size)], name, { lastModified });
    expect(matchesJob(stored, file)).toBe(false);
  });
});

describe("quota", () => {
  it("reports gracefully when the browser will not say", async () => {
    const report = await checkQuota();
    expect(report).toHaveProperty("persisted");
  });

  it("does not throw when persistence cannot be requested", async () => {
    await expect(requestPersistence()).resolves.toBe(false);
  });

  it("allows a job when free space is unknown", async () => {
    await expect(assertRoomFor(10 ** 9)).resolves.toBeUndefined();
  });

  it("refuses a job that will not fit, before any work is done", async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { estimate: async () => ({ usage: 900, quota: 1000 }) } },
      configurable: true,
    });

    // Failing at the start is far better than failing at 80%.
    await expect(assertRoomFor(1_000_000)).rejects.toThrow(/Not enough storage/);

    Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
  });

  it("allows a job that fits with headroom", async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { estimate: async () => ({ usage: 0, quota: 10_000_000 }) } },
      configurable: true,
    });

    await expect(assertRoomFor(1_000_000)).resolves.toBeUndefined();

    Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
  });
});
