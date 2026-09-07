/**
 * IndexedDB persistence for resuming interrupted jobs.
 *
 * A 1 GB source takes minutes to package; a closed tab must not cost the user
 * that work. IndexedDB is the right home for this — it is client-side (no
 * server, per the project's core constraint), holds gigabytes, and stores Blobs
 * natively (PLAN.md §3e).
 *
 * SECURITY: this store holds job progress and pending output only. It must
 * never contain credentials, signed URLs or adapter configuration
 * (SECURITY.md §6).
 */

const DB_NAME = "bitrate";
const DB_VERSION = 1;

const STORE_JOBS = "jobs";
const STORE_SEGMENTS = "segments";

/** Persisted state of one video being packaged. */
export interface StoredJob {
  jobId: string;
  /** For display and for matching a re-picked file. */
  fileName: string;
  fileSize: number;
  lastModified: number;
  /** Options needed to resume identically. */
  settings: { prefix: string; segmentDuration: number };
  status: "processing" | "done" | "failed";
  /** Index of the last segment fully produced; resume starts after this. */
  lastCompletedSegment: number;
  /** Samples consumed so far, so reading can restart at the right frame. */
  samplesProcessed: number;
  /**
   * Duration of each completed segment, in order.
   *
   * Needed on resume so the rebuilt playlist lists the earlier segments and the
   * decode timeline continues rather than restarting at zero.
   */
  completedSegmentDurations?: number[];
  createdAt: number;
  updatedAt: number;
  /**
   * A handle to the source file, when the browser supports storing one.
   *
   * Chrome/Edge can persist a `FileSystemFileHandle` and re-acquire permission
   * with a single click. Elsewhere this is absent and the user re-picks the
   * file, which is verified against the size/name/date above.
   */
  fileHandle?: unknown;
}

/** An output file produced but not yet confirmed uploaded. */
export interface StoredSegment {
  /** `${jobId}/${name}` — the primary key. */
  key: string;
  jobId: string;
  name: string;
  blob: Blob;
  contentType: string;
  isManifest: boolean;
  uploaded: boolean;
}

/** True when this environment can persist anything at all. */
export function isStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Open (and if needed create) the database. */
export function openDatabase(name = DB_NAME): Promise<IDBDatabase> {
  if (!isStorageAvailable()) {
    return Promise.reject(new Error("IndexedDB is unavailable; jobs cannot be resumed"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_JOBS)) {
        db.createObjectStore(STORE_JOBS, { keyPath: "jobId" });
      }
      if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
        const store = db.createObjectStore(STORE_SEGMENTS, { keyPath: "key" });
        // Lets us fetch or delete everything for one job without a full scan.
        store.createIndex("jobId", "jobId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onblocked = () =>
      reject(new Error("IndexedDB upgrade blocked by another open tab; close it and retry"));
  });
}

/** Wait for a transaction to commit, so callers can await durability. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Persistence for in-progress packaging jobs. */
export class JobStore {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(name = DB_NAME): Promise<JobStore> {
    return new JobStore(await openDatabase(name));
  }

  close(): void {
    this.#db.close();
  }

  async putJob(job: StoredJob): Promise<void> {
    const tx = this.#db.transaction(STORE_JOBS, "readwrite");
    tx.objectStore(STORE_JOBS).put({ ...job, updatedAt: Date.now() });
    await done(tx);
  }

  async getJob(jobId: string): Promise<StoredJob | undefined> {
    const tx = this.#db.transaction(STORE_JOBS, "readonly");
    return promisify(tx.objectStore(STORE_JOBS).get(jobId) as IDBRequest<StoredJob | undefined>);
  }

  /** Jobs that were interrupted, newest first. */
  async resumableJobs(): Promise<StoredJob[]> {
    const tx = this.#db.transaction(STORE_JOBS, "readonly");
    const all = await promisify(tx.objectStore(STORE_JOBS).getAll() as IDBRequest<StoredJob[]>);
    return all.filter((j) => j.status === "processing").sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Record an output file that has not been confirmed uploaded. */
  async putSegment(segment: Omit<StoredSegment, "key">): Promise<void> {
    const tx = this.#db.transaction(STORE_SEGMENTS, "readwrite");
    tx.objectStore(STORE_SEGMENTS).put({ ...segment, key: `${segment.jobId}/${segment.name}` });
    await done(tx);
  }

  /** Output still awaiting upload for `jobId`. */
  async pendingSegments(jobId: string): Promise<StoredSegment[]> {
    const tx = this.#db.transaction(STORE_SEGMENTS, "readonly");
    const index = tx.objectStore(STORE_SEGMENTS).index("jobId");
    const all = await promisify(index.getAll(jobId) as IDBRequest<StoredSegment[]>);
    return all.filter((s) => !s.uploaded);
  }

  async markUploaded(jobId: string, name: string): Promise<void> {
    const tx = this.#db.transaction(STORE_SEGMENTS, "readwrite");
    const store = tx.objectStore(STORE_SEGMENTS);
    const key = `${jobId}/${name}`;
    const existing = await promisify(store.get(key) as IDBRequest<StoredSegment | undefined>);
    if (existing) store.put({ ...existing, uploaded: true });
    await done(tx);
  }

  /**
   * Delete a job and everything it stored.
   *
   * Called once every file is confirmed uploaded — video frames are user
   * content and must not linger on a shared machine (SECURITY.md §6).
   */
  async deleteJob(jobId: string): Promise<void> {
    const tx = this.#db.transaction([STORE_JOBS, STORE_SEGMENTS], "readwrite");
    tx.objectStore(STORE_JOBS).delete(jobId);

    const index = tx.objectStore(STORE_SEGMENTS).index("jobId");
    const keys = await promisify(index.getAllKeys(jobId) as IDBRequest<IDBValidKey[]>);
    for (const key of keys) tx.objectStore(STORE_SEGMENTS).delete(key);

    await done(tx);
  }

  /** Remove every job and segment. Offer this on logout. */
  async clear(): Promise<void> {
    const tx = this.#db.transaction([STORE_JOBS, STORE_SEGMENTS], "readwrite");
    tx.objectStore(STORE_JOBS).clear();
    tx.objectStore(STORE_SEGMENTS).clear();
    await done(tx);
  }
}

/**
 * Does a re-picked file look like the one this job started from?
 *
 * After a reload the browser will not silently re-read a file from disk, so the
 * user must supply it again. Matching name, size and modification time is the
 * strongest check available without reading the whole file.
 */
export function matchesJob(job: StoredJob, file: File): boolean {
  return (
    file.name === job.fileName &&
    file.size === job.fileSize &&
    file.lastModified === job.lastModified
  );
}

/** Free space report, so a large job can fail fast instead of at 80%. */
export interface QuotaReport {
  /** Bytes already used by this origin, when the browser reports it. */
  usage?: number;
  /** Bytes this origin may use. */
  quota?: number;
  /** Bytes still available. */
  available?: number;
  /** Whether storage is exempt from eviction under disk pressure. */
  persisted: boolean;
}

/** Ask the browser what storage is available. */
export async function checkQuota(): Promise<QuotaReport> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { persisted: false };
  }
  const { usage, quota } = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;

  const report: QuotaReport = { persisted };
  if (usage !== undefined) report.usage = usage;
  if (quota !== undefined) report.quota = quota;
  if (usage !== undefined && quota !== undefined) report.available = quota - usage;
  return report;
}

/**
 * Ask the browser not to evict our data under disk pressure.
 *
 * Worth calling before a long job: without it, a browser reclaiming space can
 * discard the very progress we are storing.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Verify there is room for a job before starting it.
 *
 * @throws if the browser reports less free space than the estimate requires.
 */
export async function assertRoomFor(bytes: number): Promise<void> {
  const quota = await checkQuota();
  if (quota.available === undefined) return; // Browser will not say; proceed.

  // Output is roughly the size of the input in remux mode; ask for headroom.
  const needed = Math.ceil(bytes * 1.2);
  if (quota.available < needed) {
    throw new Error(
      `Not enough storage: this job needs about ${formatBytes(needed)} but only ${formatBytes(quota.available)} is available. Free up space and try again.`,
    );
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
