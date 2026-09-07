import { checkQuota, isSupported, levelForFrame } from "bitrate-js";
import { useEffect, useState } from "react";

import { formatBytes } from "../lib/format";

interface EncoderCheck {
  label: string;
  codec: string;
  supported: boolean | null;
}

/**
 * What this browser can actually do, checked rather than assumed.
 *
 * The encoder table exists because a hardcoded codec string was a real bug: a
 * level that cannot express 1080p is rejected at configure time, and the only
 * symptom was an unrelated error much later.
 */
export function CapabilitiesPanel() {
  const support = isSupported();
  const [quota, setQuota] = useState<Awaited<ReturnType<typeof checkQuota>> | null>(null);
  const [encoders, setEncoders] = useState<EncoderCheck[]>([]);

  useEffect(() => {
    void checkQuota().then(setQuota);

    if (typeof VideoEncoder !== "function") return;
    const sizes: [string, number, number][] = [
      ["480p", 854, 480],
      ["720p", 1280, 720],
      ["1080p", 1920, 1080],
      ["1440p", 2560, 1440],
      ["2160p (4K)", 3840, 2160],
    ];

    void Promise.all(
      sizes.map(async ([label, width, height]) => {
        const level = levelForFrame(width, height, 30).toString(16).padStart(2, "0");
        const codec = `avc1.4d00${level}`;
        try {
          const result = await VideoEncoder.isConfigSupported({
            codec,
            width,
            height,
            bitrate: 4_000_000,
            framerate: 30,
          });
          return { label, codec, supported: result.supported ?? false };
        } catch {
          return { label, codec, supported: false };
        }
      }),
    ).then(setEncoders);
  }, []);

  const rows: [string, boolean, string][] = [
    ["Remux", support.remux, "Chunk without re-encoding. Needs only WASM."],
    ["Transcode", support.transcode, "Re-encode into a ladder. Needs WebCodecs."],
    ["Resume", support.resume, "Survive a closed tab. Needs IndexedDB."],
    [
      "One-click resume",
      support.seamlessResume,
      "Resume without re-picking the file. Needs the File System Access API.",
    ],
  ];

  return (
    <>
      <section className="card">
        <h2>What this browser supports</h2>
        <p className="lede">
          Feature-detect before starting work, then steer users to what their browser can do
          instead of failing halfway through.
        </p>

        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Available</th>
              <th>Requires</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, on, why]) => (
              <tr key={name}>
                <td style={{ fontWeight: 600 }}>{name}</td>
                <td>
                  <span className={`chip ${on ? "ok" : "no"}`}>{on ? "yes" : "no"}</span>
                </td>
                <td style={{ color: "var(--muted)", fontSize: "0.84rem" }}>{why}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {support.reasons.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            {support.reasons.map((reason) => (
              <p key={reason} className="note warn" style={{ marginBottom: "0.4rem" }}>
                {reason}
              </p>
            ))}
          </div>
        )}
      </section>

      {encoders.length > 0 && (
        <section className="card">
          <h2>Encoder support by resolution</h2>
          <p className="lede">
            The H.264 level has to match the frame size. Each row is checked live with{" "}
            <code>VideoEncoder.isConfigSupported</code> rather than assumed — assuming one level
            for every rung was a real bug, and it failed only at 720p and above.
          </p>
          <table>
            <thead>
              <tr>
                <th>Resolution</th>
                <th>Codec string</th>
                <th>Supported</th>
              </tr>
            </thead>
            <tbody>
              {encoders.map((check) => (
                <tr key={check.label}>
                  <td style={{ fontWeight: 600 }}>{check.label}</td>
                  <td className="mono">{check.codec}</td>
                  <td>
                    <span className={`chip ${check.supported ? "ok" : "no"}`}>
                      {check.supported ? "yes" : "no"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {quota && (
        <section className="card">
          <h2>Storage</h2>
          <p className="lede">
            Checked before a long job so it can fail immediately rather than at 80%.
          </p>
          <div className="stats">
            <div className="stat">
              <span>Quota</span>
              <strong>{quota.quota ? formatBytes(quota.quota) : "unknown"}</strong>
            </div>
            <div className="stat">
              <span>Used</span>
              <strong>{quota.usage !== undefined ? formatBytes(quota.usage) : "—"}</strong>
            </div>
            <div className="stat">
              <span>Free</span>
              <strong>{quota.available !== undefined ? formatBytes(quota.available) : "—"}</strong>
            </div>
            <div className="stat">
              <span>Eviction-proof</span>
              <strong style={{ color: quota.persisted ? "var(--ok)" : "var(--muted)" }}>
                {quota.persisted ? "yes" : "no"}
              </strong>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
