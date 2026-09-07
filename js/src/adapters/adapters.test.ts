/**
 * Adapter tests.
 *
 * Provider SDKs are stubbed structurally — the adapters accept an
 * already-authenticated client rather than credentials, which is exactly what
 * makes them testable without network or secrets (SECURITY.md §1).
 */

import { describe, expect, it, vi } from "vitest";

import { PermanentUploadError } from "../upload.js";
import type { UploadItem } from "../types.js";
import { presignedAdapter } from "./presigned.js";
import { s3Adapter } from "./s3.js";
import { supabaseAdapter } from "./supabase.js";
import { appwriteAdapter, toAppwriteFileId } from "./appwrite.js";
import { firebaseAdapter } from "./firebase.js";

function segment(name = "720p_00001.m4s"): UploadItem {
  return {
    jobId: "job_1",
    name,
    blob: new Blob([new Uint8Array([1, 2, 3, 4])]),
    contentType: "video/mp4",
    isManifest: false,
  };
}

function manifest(name = "720p.m3u8"): UploadItem {
  return {
    jobId: "job_1",
    name,
    blob: new Blob(["#EXTM3U"]),
    contentType: "application/vnd.apple.mpegurl",
    isManifest: true,
  };
}

describe("presignedAdapter", () => {
  it("PUTs the bytes to the signed URL with the right content type", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upload = presignedAdapter({ getUrl: (i) => `https://sign.test/${i.name}?sig=abc` });
    await upload(segment());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sign.test/720p_00001.m4s?sig=abc");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("video/mp4");
    // Signed URLs carry their own auth; ambient cookies must not be attached.
    expect(init.credentials).toBe("omit");

    vi.unstubAllGlobals();
  });

  it("redacts the signature from error messages", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500, statusText: "Boom" }));

    const upload = presignedAdapter({ getUrl: () => "https://sign.test/x?X-Amz-Signature=SECRET" });
    // A leaked signature in a log is a credential leak.
    await expect(upload(segment())).rejects.toThrow(/<redacted>/);
    await expect(upload(segment())).rejects.not.toThrow(/SECRET/);

    vi.unstubAllGlobals();
  });
});

describe("s3Adapter", () => {
  function stubS3() {
    const sent: Record<string, unknown>[] = [];
    class PutObjectCommand {
      constructor(public input: Record<string, unknown>) {
        sent.push(input);
      }
    }
    const client = { send: vi.fn(async () => ({})) };
    return { client, PutObjectCommand, sent };
  }

  it("writes to the bucket with the key, type and cache headers", async () => {
    const { client, PutObjectCommand, sent } = stubS3();
    const upload = s3Adapter({
      client,
      putObjectCommand: PutObjectCommand,
      bucket: "videos",
      prefix: "hls",
    });

    await upload(segment());
    expect(client.send).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      Bucket: "videos",
      Key: "hls/720p_00001.m4s",
      ContentType: "video/mp4",
    });
    // Segments never change once written, so they can be cached indefinitely.
    expect(sent[0]!.CacheControl).toContain("immutable");
  });

  it("uses a short cache lifetime for playlists", async () => {
    const { client, PutObjectCommand, sent } = stubS3();
    const upload = s3Adapter({ client, putObjectCommand: PutObjectCommand, bucket: "v" });
    await upload(manifest());
    expect(sent[0]!.CacheControl).not.toContain("immutable");
  });

  it("treats auth and missing-bucket failures as permanent", async () => {
    for (const failure of [
      { name: "AccessDenied" },
      { name: "NoSuchBucket" },
      { name: "Whatever", $metadata: { httpStatusCode: 403 } },
    ]) {
      const { PutObjectCommand } = stubS3();
      const client = {
        send: async () => {
          throw failure;
        },
      };
      const upload = s3Adapter({ client, putObjectCommand: PutObjectCommand, bucket: "v" });
      // Retrying these would waste time and hammer the endpoint.
      await expect(upload(segment())).rejects.toBeInstanceOf(PermanentUploadError);
    }
  });

  it("treats a 500 as retryable", async () => {
    const { PutObjectCommand } = stubS3();
    const client = {
      send: async () => {
        throw { name: "InternalError", $metadata: { httpStatusCode: 500 } };
      },
    };
    const upload = s3Adapter({ client, putObjectCommand: PutObjectCommand, bucket: "v" });
    await expect(upload(segment())).rejects.not.toBeInstanceOf(PermanentUploadError);
  });

  it("validates its configuration up front", () => {
    const { client, PutObjectCommand } = stubS3();
    expect(() => s3Adapter({ client, putObjectCommand: PutObjectCommand, bucket: "" })).toThrow(/bucket/);
    expect(() =>
      s3Adapter({ client: {} as never, putObjectCommand: PutObjectCommand, bucket: "v" }),
    ).toThrow(/send/);
    expect(() =>
      s3Adapter({ client, putObjectCommand: undefined as never, bucket: "v" }),
    ).toThrow(/PutObjectCommand/);
  });

  it("refuses a prefix that would escape the bucket path", async () => {
    const { client, PutObjectCommand } = stubS3();
    const upload = s3Adapter({ client, putObjectCommand: PutObjectCommand, bucket: "v", prefix: ".." });
    await expect(upload(segment())).rejects.toBeInstanceOf(PermanentUploadError);
  });
});

describe("supabaseAdapter", () => {
  function stubSupabase(error: { message: string; statusCode?: string } | null = null) {
    const calls: { path: string; options: Record<string, unknown> }[] = [];
    const client = {
      storage: {
        from: (_bucket: string) => ({
          upload: async (path: string, _body: Blob, options: Record<string, unknown> = {}) => {
            calls.push({ path, options });
            return { error };
          },
        }),
      },
    };
    return { client, calls };
  }

  it("uploads to the bucket path with content type and cache control", async () => {
    const { client, calls } = stubSupabase();
    const upload = supabaseAdapter({ client, bucket: "videos", prefix: "hls" });
    await upload(segment());

    expect(calls[0]!.path).toBe("hls/720p_00001.m4s");
    expect(calls[0]!.options).toMatchObject({ contentType: "video/mp4", upsert: true });
    expect(Number(calls[0]!.options.cacheControl)).toBeGreaterThan(1000);
  });

  it("upserts by default so retries are idempotent", async () => {
    const { client, calls } = stubSupabase();
    await supabaseAdapter({ client, bucket: "v" })(segment());
    expect(calls[0]!.options.upsert).toBe(true);
  });

  it("treats an RLS denial as permanent", async () => {
    const { client } = stubSupabase({ message: "new row violates row-level security policy" });
    const upload = supabaseAdapter({ client, bucket: "v" });
    await expect(upload(segment())).rejects.toBeInstanceOf(PermanentUploadError);
  });

  it("treats a server error as retryable", async () => {
    const { client } = stubSupabase({ message: "gateway timeout", statusCode: "504" });
    const upload = supabaseAdapter({ client, bucket: "v" });
    await expect(upload(segment())).rejects.not.toBeInstanceOf(PermanentUploadError);
  });

  it("validates its configuration", () => {
    const { client } = stubSupabase();
    expect(() => supabaseAdapter({ client, bucket: "" })).toThrow(/bucket/);
    expect(() => supabaseAdapter({ client: {} as never, bucket: "v" })).toThrow(/Supabase client/);
  });
});

describe("appwriteAdapter", () => {
  function stubAppwrite(error?: unknown) {
    const calls: { bucketId: string; fileId: string; name: string; type: string }[] = [];
    const storage = {
      createFile: async (bucketId: string, fileId: string, file: File) => {
        if (error) throw error;
        calls.push({ bucketId, fileId, name: file.name, type: file.type });
        return {};
      },
    };
    return { storage, calls };
  }

  it("creates the file with its content type preserved", async () => {
    const { storage, calls } = stubAppwrite();
    const upload = appwriteAdapter({ storage, bucketId: "videos" });
    await upload(segment());

    expect(calls[0]).toMatchObject({ bucketId: "videos", type: "video/mp4" });
    expect(calls[0]!.name).toBe("720p_00001.m4s");
  });

  it("maps names into Appwrite's restricted file-id format", () => {
    // Appwrite ids: max 36 chars of [a-zA-Z0-9._-], not starting with a special.
    const id = toAppwriteFileId("job_abc", "720p_00001.m4s");
    expect(id.length).toBeLessThanOrEqual(36);
    expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  });

  it("produces stable ids so retries overwrite rather than duplicate", () => {
    const a = toAppwriteFileId("job_1", "720p_00001.m4s");
    const b = toAppwriteFileId("job_1", "720p_00001.m4s");
    expect(a).toBe(b);
  });

  it("keeps long names unique instead of colliding after truncation", () => {
    const long = "a".repeat(40);
    const first = toAppwriteFileId(long, "720p_00001.m4s");
    const second = toAppwriteFileId(long, "720p_00002.m4s");
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(36);
  });

  it("rejects unsafe names before building an id", () => {
    expect(() => toAppwriteFileId("p", "../escape.m4s")).toThrow(PermanentUploadError);
  });

  it("classifies permission errors as permanent", async () => {
    const { storage } = stubAppwrite({ code: 401, message: "User not authorized" });
    const upload = appwriteAdapter({ storage, bucketId: "v" });
    await expect(upload(segment())).rejects.toBeInstanceOf(PermanentUploadError);
  });

  it("classifies a server error as retryable", async () => {
    const { storage } = stubAppwrite({ code: 500, message: "Server error" });
    const upload = appwriteAdapter({ storage, bucketId: "v" });
    await expect(upload(segment())).rejects.not.toBeInstanceOf(PermanentUploadError);
  });

  it("validates its configuration", () => {
    const { storage } = stubAppwrite();
    expect(() => appwriteAdapter({ storage, bucketId: "" })).toThrow(/bucketId/);
    expect(() => appwriteAdapter({ storage: {} as never, bucketId: "v" })).toThrow(/Storage/);
  });
});

describe("no adapter accepts raw credentials", () => {
  it("has no option named like a secret", () => {
    // A guard against regressions: an API that invites secrets into browser
    // code is itself the vulnerability (SECURITY.md §1).
    const sources = [s3Adapter, supabaseAdapter, appwriteAdapter, presignedAdapter, firebaseAdapter]
      .map((fn) => fn.toString())
      .join("\n");

    for (const forbidden of [
      "accessKeyId",
      "secretAccessKey",
      "serviceRoleKey",
      "service_role",
      "apiKey",
    ]) {
      expect(sources, forbidden).not.toContain(`options.${forbidden}`);
    }
  });
});

describe("firebase adapter", () => {
  /** A stand-in for `firebase/storage`, recording what it was asked to do. */
  function fakeFirebase(fail?: { code?: string; message?: string }) {
    const calls: { path: string; metadata: Record<string, unknown> }[] = [];
    return {
      calls,
      deps: {
        storage: { app: "test" },
        ref: (_storage: object, path: string) => ({ path }),
        uploadBytes: async (reference: object, _data: Blob, metadata?: Record<string, unknown>) => {
          calls.push({ path: (reference as { path: string }).path, metadata: metadata ?? {} });
          if (fail) throw Object.assign(new Error(fail.message ?? "nope"), { code: fail.code });
          return {};
        },
      },
    };
  }

  const item = (over: Partial<UploadItem> = {}): UploadItem => ({
    jobId: "job_1",
    name: "video_00001.m4s",
    blob: new Blob([new Uint8Array(8)]),
    contentType: "video/mp4",
    isManifest: false,
    ...over,
  });

  it("writes under the prefix", async () => {
    const fb = fakeFirebase();
    await firebaseAdapter({ ...fb.deps, prefix: "hls/user_9" })(item());
    expect(fb.calls[0]!.path).toBe("hls/user_9/video_00001.m4s");
  });

  it("caches segments hard and playlists briefly", async () => {
    const fb = fakeFirebase();
    const upload = firebaseAdapter(fb.deps);

    await upload(item());
    await upload(item({ name: "video.m3u8", contentType: "application/vnd.apple.mpegurl", isManifest: true }));

    // A segment never changes; a playlist is rewritten as the job progresses,
    // and a cached one leaves players reading a stale segment list.
    expect(fb.calls[0]!.metadata.cacheControl).toMatch(/immutable/);
    expect(fb.calls[1]!.metadata.cacheControl).toBe("public, max-age=60");
  });

  it("passes the content type through, without which playback fails", async () => {
    const fb = fakeFirebase();
    await firebaseAdapter(fb.deps)(item());
    expect(fb.calls[0]!.metadata.contentType).toBe("video/mp4");
  });

  it("treats a rules denial as permanent, so the queue stops retrying", async () => {
    const fb = fakeFirebase({ code: "storage/unauthorized", message: "User does not have permission" });
    await expect(firebaseAdapter(fb.deps)(item())).rejects.toBeInstanceOf(PermanentUploadError);
  });

  it("treats a transient failure as retryable", async () => {
    const fb = fakeFirebase({ code: "storage/retry-limit-exceeded", message: "timeout" });
    const error = await firebaseAdapter(fb.deps)(item()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentUploadError);
  });

  it("names the file in the error, so a failed batch says which one", async () => {
    const fb = fakeFirebase({ code: "storage/unauthorized" });
    await expect(firebaseAdapter(fb.deps)(item())).rejects.toThrow(/video_00001\.m4s/);
  });

  it("refuses a caller that forgot the firebase/storage functions", () => {
    expect(() => firebaseAdapter({ storage: {} } as never)).toThrow(/ref.*uploadBytes/s);
  });
});

describe("per-file headers on the pre-signed adapter", () => {
  const item = (over: Partial<UploadItem> = {}): UploadItem => ({
    jobId: "job_1",
    name: "video_00001.m4s",
    blob: new Blob([new Uint8Array(4)]),
    contentType: "video/mp4",
    isManifest: false,
    ...over,
  });

  it("still accepts a fixed object, as Azure needs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await presignedAdapter({
      getUrl: () => "https://x.blob.core.windows.net/c/b?sig=abc",
      headers: { "x-ms-blob-type": "BlockBlob" },
    })(item());

    const sent = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((sent.headers as Record<string, string>)["x-ms-blob-type"]).toBe("BlockBlob");
    vi.unstubAllGlobals();
  });

  it("lets a playlist and a segment carry different cache lifetimes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upload = presignedAdapter({
      getUrl: () => "https://example.com/o?sig=abc",
      headers: (f) => ({
        "Cache-Control": f.isManifest ? "public, max-age=60" : "public, max-age=31536000, immutable",
      }),
    });

    await upload(item());
    await upload(item({ isManifest: true, name: "video.m3u8" }));

    const headerFor = (i: number) =>
      fetchMock.mock.calls[i]![1]!.headers as Record<string, string>;
    expect(headerFor(0)["Cache-Control"]).toMatch(/immutable/);
    expect(headerFor(1)["Cache-Control"]).toBe("public, max-age=60");
    vi.unstubAllGlobals();
  });
});
