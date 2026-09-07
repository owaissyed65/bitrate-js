import { HlsQueue } from "bitrate-js";
import type { UploadItem } from "bitrate-js";
import { useRef, useState } from "react";

import { formatBytes } from "../lib/format";
import { Dropzone } from "./Dropzone";

interface JobView {
  id: string;
  name: string;
  size: number;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  progress: number;
  files: number;
  error?: string;
}

interface UploadRow {
  jobId: string;
  name: string;
  size: number;
  contentType: string;
  attempt: number;
}

/**
 * Many files at once, with the failure behaviour on show.
 *
 * The interesting property is not that a batch succeeds — it is that a batch
 * with a broken file in the middle still finishes, and says which one failed.
 */
export function QueuePanel() {
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<{ ok: number; failed: number; attempts: number } | null>(
    null,
  );
  const [flaky, setFlaky] = useState(false);
  const [includeBroken, setIncludeBroken] = useState(true);
  const queueRef = useRef<HlsQueue | null>(null);

  function addFiles(picked: File[]) {
    setFiles((prev) => [...prev, ...picked]);
    setReport(null);
  }

  async function run() {
    const batch = [...files];
    if (includeBroken) {
      // A deliberately broken file, to show the batch surviving it.
      batch.splice(
        Math.min(1, batch.length),
        0,
        new File([new Uint8Array(4096).fill(7)], "corrupt.mp4", { type: "video/mp4" }),
      );
    }
    if (batch.length === 0) return;

    setRunning(true);
    setUploads([]);
    setReport(null);

    const views = new Map<string, JobView>();
    let attempts = 0;

    const queue = new HlsQueue({
      segmentDuration: 6,
      concurrency: 1,
      retries: flaky ? 4 : 2,
      upload: async (item: UploadItem) => {
        attempts++;
        // Simulate an unreliable network to show retries working.
        if (flaky && Math.random() < 0.35) throw new Error("simulated network blip");
        setUploads((rows) => [
          ...rows,
          {
            jobId: item.jobId,
            name: item.name,
            size: item.blob.size,
            contentType: item.contentType,
            attempt: attempts,
          },
        ]);
        const view = views.get(item.jobId);
        if (view) {
          view.files++;
          setJobs([...views.values()]);
        }
      },
      onProgress: ({ jobId, percent }) => {
        const view = views.get(jobId);
        if (view) {
          view.progress = percent / 100;
          view.status = "processing";
          setJobs([...views.values()]);
        }
      },
      onJobDone: ({ jobId }) => {
        const view = views.get(jobId);
        if (view) {
          view.status = "done";
          view.progress = 1;
          setJobs([...views.values()]);
        }
      },
      onJobError: ({ jobId, error }) => {
        const view = views.get(jobId);
        if (view) {
          view.status = "failed";
          view.error = error.message;
          setJobs([...views.values()]);
        }
      },
    });
    queueRef.current = queue;

    const ids = queue.add(batch);
    ids.forEach((id, i) => {
      views.set(id, {
        id,
        name: batch[i]!.name,
        size: batch[i]!.size,
        status: "queued",
        progress: 0,
        files: 0,
      });
    });
    setJobs([...views.values()]);

    const result = await queue.drain();

    // Reflect any state the callbacks did not cover, such as cancellation.
    for (const job of queue.jobs) {
      const view = views.get(job.id);
      if (view && view.status !== "done" && view.status !== "failed") {
        view.status = job.status;
        if (job.error) view.error = job.error.message;
      }
    }
    setJobs([...views.values()]);
    setReport({ ok: result.succeeded.length, failed: result.failed.length, attempts });
    setRunning(false);
  }

  return (
    <>
      <section className="card">
        <h2>Queue several files</h2>
        <p className="lede">
          Files are packaged one at a time so a batch cannot overwhelm the tab, and each output
          file is uploaded and released as it is produced. A file that fails is recorded and
          skipped — <code>drain()</code> never rejects.
        </p>

        <Dropzone
          multiple
          onFiles={addFiles}
          label="Add videos"
          hint="Pick several. They are processed in order."
        />

        <div className="row" style={{ marginTop: "0.9rem" }}>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={includeBroken}
              onChange={(e) => setIncludeBroken(e.target.checked)}
              disabled={running}
            />
            insert a corrupt file
          </label>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={flaky}
              onChange={(e) => setFlaky(e.target.checked)}
              disabled={running}
            />
            flaky uploads (exercise retries)
          </label>

          <div className="spacer" />
          {files.length > 0 && !running && (
            <button className="ghost" onClick={() => setFiles([])}>
              Clear {files.length}
            </button>
          )}
          <button onClick={() => void run()} disabled={running || files.length === 0}>
            {running ? "Running…" : `Run batch (${files.length + (includeBroken ? 1 : 0)})`}
          </button>
          {running && (
            <button className="ghost" onClick={() => queueRef.current?.cancel()}>
              Cancel
            </button>
          )}
        </div>

        {files.length === 0 && (
          <p className="note" style={{ marginTop: "0.9rem" }}>
            Add at least one video. The corrupt file is generated for you.
          </p>
        )}
      </section>

      {jobs.length > 0 && (
        <section className="card">
          <h2>Jobs</h2>
          <div className="jobs">
            {jobs.map((job) => (
              <div key={job.id} className={`job ${job.status}`}>
                <div className="job-head">
                  <span className="job-name">{job.name}</span>
                  <span className="job-meta">{formatBytes(job.size)}</span>
                  <div className="spacer" />
                  {job.files > 0 && <span className="job-meta">{job.files} files uploaded</span>}
                  <span className={`status ${job.status}`}>{job.status}</span>
                </div>
                <div
                  className={`bar${job.status === "done" ? " done" : ""}${
                    job.status === "failed" ? " err" : ""
                  }`}
                >
                  <i style={{ width: `${(job.status === "failed" ? 1 : job.progress) * 100}%` }} />
                </div>
                {job.error && <div className="job-err">{job.error}</div>}
              </div>
            ))}
          </div>

          {report && (
            <p
              className={`note ${report.failed > 0 && report.ok > 0 ? "ok" : report.ok === 0 ? "err" : "ok"}`}
              style={{ marginTop: "1rem" }}
            >
              <strong>
                {report.ok} succeeded, {report.failed} failed
              </strong>{" "}
              — {uploads.length} files uploaded in {report.attempts} attempts
              {report.attempts > uploads.length && ` (${report.attempts - uploads.length} retries)`}.
              {report.failed > 0 && report.ok > 0 && " The bad file was skipped and the batch finished."}
            </p>
          )}
        </section>
      )}

      {uploads.length > 0 && (
        <section className="card">
          <h2>What your upload adapter received</h2>
          <p className="lede">
            Every backend gets the same shape, whether it is S3, Supabase, Appwrite or your own{" "}
            <code>fetch</code>. This mock just records it.
          </p>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Name</th>
                  <th>Content type</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((row, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ color: "var(--dim)" }}>
                      {row.jobId.slice(0, 10)}
                    </td>
                    <td className="mono">{row.name}</td>
                    <td style={{ color: "var(--muted)", fontSize: "0.8rem" }}>{row.contentType}</td>
                    <td className="num">{formatBytes(row.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
