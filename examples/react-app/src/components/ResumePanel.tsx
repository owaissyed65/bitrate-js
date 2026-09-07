import { HlsQueue, JobStore, checkQuota, remux } from "bitrate-js";
import type { StoredJob } from "bitrate-js";
import { useEffect, useState } from "react";

import { formatBytes } from "../lib/format";
import { Dropzone } from "./Dropzone";

interface Step {
  label: string;
  detail?: string;
  state: "pending" | "running" | "ok" | "err";
}

/**
 * Interrupt a job, then continue it — and check the result against an
 * uninterrupted run of the same file.
 *
 * The claim being demonstrated is precise: resuming reproduces exactly the
 * segments the uninterrupted run produced, no more and no fewer.
 */
export function ResumePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [stored, setStored] = useState<StoredJob[]>([]);
  const [quota, setQuota] = useState<string>("");

  useEffect(() => {
    void refreshStored();
    void checkQuota().then((q) => {
      if (q.available !== undefined) {
        setQuota(`${formatBytes(q.available)} free of ${formatBytes(q.quota ?? 0)}`);
      }
    });
  }, []);

  async function refreshStored() {
    try {
      const store = await JobStore.open();
      setStored(await store.resumableJobs());
      store.close();
    } catch {
      setStored([]);
    }
  }

  function push(step: Step) {
    setSteps((prev) => [...prev, step]);
  }

  function settle(index: number, state: Step["state"], detail?: string) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, state, ...(detail ? { detail } : {}) } : s)));
  }

  async function run() {
    if (!file) return;
    setRunning(true);
    setSteps([]);

    const store = await JobStore.open();
    // Start clean so a previous demo run cannot confuse the comparison.
    await store.clear();

    try {
      // --- reference ---
      push({ label: "Package the file uninterrupted, as a reference", state: "running" });
      let reference = 0;
      for await (const item of remux(file, { prefix: "ref", segmentDuration: 2 })) {
        if (item.name.endsWith(".m4s")) reference++;
      }
      settle(0, "ok", `${reference} segments`);

      // --- interrupted session ---
      push({ label: "Start packaging, then close the tab partway", state: "running" });
      let uploadedBefore = 0;
      const first: HlsQueue = new HlsQueue({
        segmentDuration: 2,
        store,
        upload: async (item) => {
          if (item.name.endsWith(".m4s")) {
            uploadedBefore++;
            // Simulate the tab closing once a few segments are safely stored.
            if (uploadedBefore >= Math.max(2, Math.floor(reference / 3))) first.cancel();
          }
        },
      });
      first.add(file);
      await first.drain();
      settle(1, "ok", `${uploadedBefore} segments uploaded, then interrupted`);

      // --- checkpoint ---
      push({ label: "Find the checkpoint that survived", state: "running" });
      const interrupted = await store.resumableJobs();
      if (interrupted.length === 0) {
        settle(2, "err", "nothing was checkpointed");
        return;
      }
      const job = interrupted[0]!;
      const done = job.completedSegmentDurations?.length ?? 0;
      settle(
        2,
        "ok",
        `${done} segments and ${job.samplesProcessed.toLocaleString()} frames recorded${
          job.audioSamplesProcessed ? `, ${job.audioSamplesProcessed.toLocaleString()} audio frames` : ""
        }`,
      );
      await refreshStored();

      // --- resume ---
      push({ label: "Reopen and continue from the checkpoint", state: "running" });
      let producedAfter = 0;
      const second = new HlsQueue({
        segmentDuration: 2,
        store,
        upload: async (item) => {
          if (item.name.endsWith(".m4s")) producedAfter++;
        },
      });
      second.addResume({ stored: job, file });
      const result = await second.drain();
      settle(3, result.succeeded.length === 1 ? "ok" : "err", `${producedAfter} further segments`);

      // --- the actual claim ---
      push({ label: "Check nothing was lost or repeated", state: "running" });
      const total = done + producedAfter;
      settle(
        4,
        total === reference ? "ok" : "err",
        `${done} + ${producedAfter} = ${total} segments, against ${reference} uninterrupted`,
      );

      // --- guard rail ---
      push({ label: "Refuse to resume onto a different file", state: "running" });
      try {
        second.addResume({
          stored: job,
          file: new File([new Uint8Array(64)], "someone-elses-video.mp4"),
        });
        settle(5, "err", "a mismatched file was accepted");
      } catch (e) {
        settle(5, "ok", e instanceof Error ? e.message.slice(0, 90) + "…" : "rejected");
      }

      // --- cleanup ---
      push({ label: "Clean up once everything is uploaded", state: "running" });
      const left = await store.resumableJobs();
      settle(6, left.length === 0 ? "ok" : "err", `${left.length} jobs left in storage`);
      await refreshStored();
    } catch (e) {
      push({ label: "Failed", detail: e instanceof Error ? e.message : String(e), state: "err" });
    } finally {
      store.close();
      setRunning(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Survive a closed tab</h2>
        <p className="lede">
          Progress is checkpointed to IndexedDB — client-side, since a server database would defeat
          the point. This runs a file, kills it partway, resumes it, and checks the result against
          an uninterrupted run of the same file.
        </p>

        {!file ? (
          <Dropzone onFiles={(f) => setFile(f[0]!)} label="Choose a video to interrupt" />
        ) : (
          <div className="row">
            <span className="chip mono">{file.name}</span>
            <span className="chip">{formatBytes(file.size)}</span>
            {quota && <span className="chip">{quota}</span>}
            <div className="spacer" />
            <button className="ghost" onClick={() => setFile(null)} disabled={running}>
              Change
            </button>
            <button onClick={() => void run()} disabled={running}>
              {running ? "Running…" : "Interrupt and resume"}
            </button>
          </div>
        )}
      </section>

      {steps.length > 0 && (
        <section className="card">
          <h2>What happened</h2>
          <div className="jobs">
            {steps.map((step, i) => (
              <div key={i} className={`job ${step.state === "err" ? "failed" : step.state === "ok" ? "done" : ""}`}>
                <div className="job-head">
                  <span
                    style={{
                      width: 20,
                      textAlign: "center",
                      color:
                        step.state === "ok"
                          ? "var(--ok)"
                          : step.state === "err"
                            ? "var(--err)"
                            : "var(--muted)",
                    }}
                  >
                    {step.state === "ok" ? "✓" : step.state === "err" ? "✕" : "…"}
                  </span>
                  <span className="job-name">{step.label}</span>
                </div>
                {step.detail && (
                  <div style={{ color: "var(--muted)", fontSize: "0.83rem", paddingLeft: "1.75rem" }}>
                    {step.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>Stored jobs</h2>
        <p className="lede">
          What is currently held in IndexedDB. A finished job deletes itself — video frames are
          user content and should not linger on a shared machine.
        </p>
        {stored.length === 0 ? (
          <div className="empty">Nothing stored.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th className="num">Segments done</th>
                <th className="num">Frames</th>
              </tr>
            </thead>
            <tbody>
              {stored.map((job) => (
                <tr key={job.jobId}>
                  <td className="mono">{job.fileName}</td>
                  <td className="num">{job.completedSegmentDurations?.length ?? 0}</td>
                  <td className="num">{job.samplesProcessed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: "0.8rem" }}>
          <button
            className="ghost small"
            onClick={async () => {
              const store = await JobStore.open();
              await store.clear();
              store.close();
              void refreshStored();
            }}
          >
            Clear storage
          </button>
        </div>
      </section>
    </>
  );
}
