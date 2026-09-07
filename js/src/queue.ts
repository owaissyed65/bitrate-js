/**
 * `HlsQueue` — process many videos and send the output anywhere.
 *
 * Files are packaged one (or a few) at a time so a batch cannot overwhelm the
 * tab, each output file is uploaded and released as it is produced, and a
 * failing file is recorded and skipped rather than aborting the batch
 * (PLAN.md §3a).
 */

import { remux, type RemuxOptions, type ResumeState } from "./remux.js";
import { JobStore, matchesJob, type StoredJob } from "./storage.js";
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

  /**
   * Persist progress so an interrupted job can be resumed after a reload.
   *
   * Open one with `await JobStore.open()`. Without it the queue still works,
   * but a closed tab loses whatever was in flight (PLAN.md §3e).
   */
  store?: JobStore;

  onProgress?: (progress: JobProgress) => void;
  onJobDone?: (result: JobResult) => void;
  /** Called per failed file; the queue continues with the rest. */
  onJobError?: (failure: JobFailure) => void;
}

/** An interrupted job, paired with the file needed to continue it. */
export interface ResumeRequest {
  stored: StoredJob;
  /** The same source file, re-picked by the user or via a stored handle. */
  file: File;
}

interface InternalJob extends QueueJob {
  file: File | Blob;
  prefix: string;
  produced: string[];
  /** Durations of segments already completed, for a resumed run. */
  resume?: ResumeState;
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

  /**
   * Queue an interrupted job to continue where it stopped.
   *
   * The file is verified against the stored name, size and modification time —
   * resuming onto a different video would splice two files together.
   *
   * @throws if the file does not match the stored job.
   */
  addResume({ stored, file }: ResumeRequest): string {
    if (!matchesJob(stored, file)) {
      throw new Error(
        `"${file.name}" does not match the interrupted job (expected "${stored.fileName}", ${stored.fileSize} bytes). Please choose the same file.`,
      );
    }

    this.#jobs.push({
      id: stored.jobId,
      fileName: stored.fileName,
      fileSize: stored.fileSize,
      status: "queued",
      // Resumed jobs keep their original prefix so earlier output still matches.
      prefix: stored.settings.prefix,
      progress: 0,
      file,
      produced: [],
      resume: {
        completedSegmentDurations: stored.completedSegmentDurations ?? [],
        samplesProcessed: stored.samplesProcessed,
      },
    });
    return stored.jobId;
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

    const store = this.#options.store;
    const segmentDuration = this.#options.segmentDuration ?? 6;
    const durations = [...(job.resume?.completedSegmentDurations ?? [])];

    const upload = this.#options.upload
      ? withRetry(this.#options.upload, {
          retries: this.#options.retries ?? 2,
          signal: this.#controller.signal,
        })
      : undefined;

    await store?.putJob(this.#snapshot(job, durations, job.resume?.samplesProcessed ?? 0, "processing"));

    const remuxOptions: RemuxOptions = {
      prefix: job.prefix,
      segmentDuration,
      signal: this.#controller.signal,
      onProgress: ({ fraction }) => {
        job.progress = fraction;
        this.#options.onProgress?.({ jobId: job.id, rung: null, percent: fraction * 100 });
      },
    };
    if (this.#options.readWindow !== undefined) remuxOptions.readWindow = this.#options.readWindow;
    if (job.resume) remuxOptions.resume = job.resume;

    // Checkpointing is driven by onSegment rather than by the output loop:
    // it reports exactly the sample count a later resume must restart from.
    let pendingCheckpoint: { durations: number[]; samplesProcessed: number } | null = null;
    if (store) {
      remuxOptions.onSegment = ({ duration, samplesProcessed }) => {
        durations.push(duration);
        pendingCheckpoint = { durations: [...durations], samplesProcessed };
      };
    }

    let masterPlaylist = "";
    for await (const output of remux(job.file, remuxOptions)) {
      if (output.isManifest) masterPlaylist = output.name;
      job.produced.push(output.name);

      if (upload) {
        await upload({ jobId: job.id, ...output });
      }

      // Written only after the file is safely uploaded, so a checkpoint never
      // claims progress that was lost.
      if (store && pendingCheckpoint) {
        const cp = pendingCheckpoint as { durations: number[]; samplesProcessed: number };
        pendingCheckpoint = null;
        await store.putJob(this.#snapshot(job, cp.durations, cp.samplesProcessed, "processing"));
      }
    }

    job.status = "done";
    job.progress = 1;

    // The job is complete and every file uploaded, so nothing needs to linger
    // on the user's disk (SECURITY.md §6).
    await store?.deleteJob(job.id);

    const result: JobResult = {
      jobId: job.id,
      masterPlaylist,
      files: job.produced,
    };
    this.#options.onJobDone?.(result);
    return result;
  }

  /** Build the persisted record for `job` at its current progress. */
  #snapshot(
    job: InternalJob,
    durations: number[],
    samplesProcessed: number,
    status: StoredJob["status"],
  ): StoredJob {
    const now = Date.now();
    return {
      jobId: job.id,
      fileName: job.fileName,
      fileSize: job.fileSize,
      lastModified: job.file instanceof File ? job.file.lastModified : 0,
      settings: { prefix: job.prefix, segmentDuration: this.#options.segmentDuration ?? 6 },
      status,
      lastCompletedSegment: durations.length - 1,
      samplesProcessed,
      completedSegmentDurations: durations,
      createdAt: now,
      updatedAt: now,
    };
  }
}
