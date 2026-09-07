/**
 * `HlsQueue` — process many videos and send the output anywhere.
 *
 * Files are packaged one (or a few) at a time so a batch cannot overwhelm the
 * tab, each output file is uploaded and released as it is produced, and a
 * failing file is recorded and skipped rather than aborting the batch
 * (PLAN.md §3a).
 */

import { remux, type RemuxOptions } from "./remux.js";
import { withRetry } from "./upload.js";
import type {
  JobFailure,
  JobProgress,
  JobResult,
  PackageMode,
  QueueReport,
  Rung,
  UploadAdapter,
} from "./types.js";

/** Status of one queued video. */
export type JobStatus = "queued" | "processing" | "done" | "failed" | "cancelled";

export interface QueueJob {
  id: string;
  fileName: string;
  fileSize: number;
  status: JobStatus;
  /** 0–1; only meaningful while processing or once done. */
  progress: number;
  error?: Error;
}

export interface HlsQueueOptions {
  /** How much work per file. Only `"remux"` is implemented today. */
  mode?: PackageMode;
  /** ABR ladder. Reserved for transcode mode (M6). */
  ladder?: Rung[];
  /** Minimum segment length in seconds. Default 6. */
  segmentDuration?: number;
  /** Files processed simultaneously. Default 1 — raise with care. */
  concurrency?: number;
  /** Extra upload attempts per file after the first. Default 2. */
  retries?: number;
  /** Bytes coalesced per source read. */
  readWindow?: number;

  /**
   * Where output goes. Omit to keep the files in the job result instead.
   *
   * SECURITY: never close over long-lived cloud credentials here — use an
   * app-owned client or a short-lived pre-signed URL (SECURITY.md §1).
   */
  upload?: UploadAdapter;

  onProgress?: (progress: JobProgress) => void;
  onJobDone?: (result: JobResult) => void;
  /** Called per failed file; the queue continues with the rest. */
  onJobError?: (failure: JobFailure) => void;
}

interface InternalJob extends QueueJob {
  file: File | Blob;
  prefix: string;
  produced: string[];
}

/** Monotonic counter making job ids unique within a queue. */
let sequence = 0;

/**
 * A safe, collision-resistant job id.
 *
 * Deliberately *not* derived from the file name: names are user input and would
 * otherwise reach storage keys (SECURITY.md §2). The name is kept only for
 * display.
 */
function newJobId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `job_${(sequence++).toString(36)}_${random}`;
}

/**
 * A queue that packages videos into HLS and uploads the result.
 *
 * @example
 * ```ts
 * const q = new HlsQueue({
 *   segmentDuration: 6,
 *   retries: 3,
 *   upload: presignedAdapter({ getUrl: (i) => sign(i.name) }),
 *   onJobError: ({ jobId, error }) => console.warn(jobId, error),
 * });
 * q.add([file1, file2, file3]);
 * const report = await q.drain();
 * ```
 */
export class HlsQueue {
  readonly #options: HlsQueueOptions;
  readonly #jobs: InternalJob[] = [];
  readonly #controller = new AbortController();

  #running = false;
  #drained: Promise<QueueReport> | null = null;

  constructor(options: HlsQueueOptions = {}) {
    if (options.mode && options.mode !== "remux" && options.mode !== "auto") {
      throw new Error(
        `mode "${options.mode}" is not implemented yet; only "remux" is available in this version`,
      );
    }
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("concurrency must be a positive integer");
    }
    this.#options = options;
  }

  /** Queue one file or many. Can be called while the queue is running. */
  add(files: File | Blob | readonly (File | Blob)[]): string[] {
    const list = Array.isArray(files) ? files : [files as File | Blob];
    return list.map((file) => {
      const id = newJobId();
      this.#jobs.push({
        id,
        fileName: file instanceof File ? file.name : "(blob)",
        fileSize: file.size,
        status: "queued",
        progress: 0,
        file,
        prefix: id,
        produced: [],
      });
      return id;
    });
  }

  /** A snapshot of every job, for rendering progress. */
  get jobs(): QueueJob[] {
    return this.#jobs.map(({ file: _file, prefix: _prefix, produced: _p, ...job }) => ({ ...job }));
  }

  /** Stop processing. In-flight files stop at the next sample boundary. */
  cancel(): void {
    this.#controller.abort(new Error("Queue cancelled"));
  }

  /**
   * Process everything queued and resolve once the batch is finished.
   *
   * Never rejects because a file failed — failures are collected in
   * `report.failed` so one bad video cannot lose a whole batch.
   */
  drain(): Promise<QueueReport> {
    this.#drained ??= this.#run();
    return this.#drained;
  }

  async #run(): Promise<QueueReport> {
    if (this.#running) throw new Error("queue is already running");
    this.#running = true;

    const succeeded: JobResult[] = [];
    const failed: JobFailure[] = [];
    const concurrency = this.#options.concurrency ?? 1;

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const job = this.#jobs[index];
        if (!job) return;

        if (this.#controller.signal.aborted) {
          job.status = "cancelled";
          continue;
        }

        try {
          succeeded.push(await this.#process(job));
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          job.status = this.#controller.signal.aborted ? "cancelled" : "failed";
          job.error = err;
          const failure: JobFailure = { jobId: job.id, error: err };
          failed.push(failure);
          // Report and continue: one bad file must not sink the batch.
          this.#options.onJobError?.(failure);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    this.#running = false;
    return { succeeded, failed };
  }

  async #process(job: InternalJob): Promise<JobResult> {
    job.status = "processing";

    const upload = this.#options.upload
      ? withRetry(this.#options.upload, {
          retries: this.#options.retries ?? 2,
          signal: this.#controller.signal,
        })
      : undefined;

    const remuxOptions: RemuxOptions = {
      prefix: job.prefix,
      segmentDuration: this.#options.segmentDuration ?? 6,
      signal: this.#controller.signal,
      onProgress: ({ fraction }) => {
        job.progress = fraction;
        this.#options.onProgress?.({ jobId: job.id, rung: null, percent: fraction * 100 });
      },
    };
    if (this.#options.readWindow !== undefined) remuxOptions.readWindow = this.#options.readWindow;

    let masterPlaylist = "";
    for await (const output of remux(job.file, remuxOptions)) {
      if (output.isManifest) masterPlaylist = output.name;
      job.produced.push(output.name);

      if (upload) {
        await upload({ jobId: job.id, ...output });
      }
    }

    job.status = "done";
    job.progress = 1;

    const result: JobResult = {
      jobId: job.id,
      masterPlaylist,
      files: job.produced,
    };
    this.#options.onJobDone?.(result);
    return result;
  }
}
