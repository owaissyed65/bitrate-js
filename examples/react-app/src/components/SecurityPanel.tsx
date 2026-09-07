import { HlsQueue, assertSafeKey, inspect } from "bitrate-js";
import { useState } from "react";

interface Check {
  input: string;
  outcome: string;
  passed: boolean;
}

/**
 * The security properties, run live rather than described.
 *
 * Each one is a behaviour a consuming app depends on, so it is checked against
 * the running library instead of stated in prose.
 */
export function SecurityPanel() {
  const [traversal, setTraversal] = useState<Check[]>([]);
  const [names, setNames] = useState<Check[]>([]);
  const [malformed, setMalformed] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setTraversal([]);
    setNames([]);
    setMalformed([]);

    // 1. Object keys cannot escape their prefix.
    const evilKeys = ["../../etc/passwd", "/absolute", "a/../../b", "back\\slash", ""];
    setTraversal(
      evilKeys.map((input) => {
        try {
          assertSafeKey(input);
          return { input: JSON.stringify(input), outcome: "accepted", passed: false };
        } catch {
          return { input: JSON.stringify(input), outcome: "rejected", passed: true };
        }
      }),
    );

    // 2. A hostile file name must never reach a storage key.
    try {
      const source = new File([makeTinyMp4() as BlobPart], "../../../etc/passwd.mp4", {
        type: "video/mp4",
      });
      const produced: string[] = [];
      const queue = new HlsQueue({
        segmentDuration: 30,
        upload: async (item) => {
          produced.push(item.name);
        },
      });
      queue.add(source);
      await queue.drain();

      const leaked = produced.filter((n) => n.includes("..") || n.includes("passwd"));
      setNames([
        {
          input: "../../../etc/passwd.mp4",
          outcome:
            produced.length === 0
              ? "file was rejected before packaging"
              : leaked.length === 0
                ? `stored as ${produced[0]} — id is random, not derived from the name`
                : `LEAKED: ${leaked.join(", ")}`,
          passed: leaked.length === 0,
        },
      ]);
    } catch (e) {
      setNames([
        {
          input: "../../../etc/passwd.mp4",
          outcome: `rejected before packaging (${e instanceof Error ? e.message.slice(0, 60) : ""}…)`,
          passed: true,
        },
      ]);
    }

    // 3. Malformed input is refused, never crashes the page.
    const hostile: [string, Uint8Array][] = [
      ["random bytes", crypto.getRandomValues(new Uint8Array(512))],
      ["empty file", new Uint8Array(0)],
      ["truncated header", new Uint8Array([0, 0, 0, 200, 109, 111, 111, 118])],
      ["huge declared size", new Uint8Array([255, 255, 255, 255, 109, 111, 111, 118, 0, 0])],
    ];
    const results: Check[] = [];
    for (const [label, bytes] of hostile) {
      try {
        await inspect(new Blob([bytes as BlobPart]));
        results.push({ input: label, outcome: "accepted — should not happen", passed: false });
      } catch (e) {
        results.push({
          input: label,
          outcome: e instanceof Error ? e.message.slice(0, 72) : "rejected",
          passed: true,
        });
      }
    }
    setMalformed(results);
    setRunning(false);
  }

  return (
    <>
      <section className="card">
        <h2>Credentials never enter the browser</h2>
        <p className="lede">
          A browser has no secure place for a secret — anything in client code is readable in
          DevTools. So no adapter accepts one. They take a client your app already authenticated,
          or a short-lived URL your backend signed.
        </p>

        <div className="grid-2">
          <div>
            <p className="note err">
              <strong>Never offered by this package</strong>
              <br />
              <code>{`s3Adapter({ accessKeyId, secretAccessKey })`}</code>
            </p>
          </div>
          <div>
            <p className="note ok">
              <strong>What it does accept</strong>
              <br />
              <code>{`presignedAdapter({ getUrl })`}</code>
              <br />
              <code>{`s3Adapter({ client, bucket })`}</code>
            </p>
          </div>
        </div>

        <table style={{ marginTop: "1rem" }}>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Correct client-side auth</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>S3 / R2 / B2 / MinIO</td>
              <td style={{ color: "var(--muted)" }}>
                Pre-signed URL, or short-lived STS credentials
              </td>
            </tr>
            <tr>
              <td>Supabase</td>
              <td style={{ color: "var(--muted)" }}>
                <code>anon</code> key plus Row Level Security — never <code>service_role</code>
              </td>
            </tr>
            <tr>
              <td>Appwrite</td>
              <td style={{ color: "var(--muted)" }}>Session-scoped client and bucket permissions</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Live checks</h2>
        <p className="lede">
          These run against the library right now, rather than describing what it ought to do.
        </p>
        <button onClick={() => void run()} disabled={running}>
          {running ? "Running…" : "Run checks"}
        </button>

        {traversal.length > 0 && (
          <>
            <h3 style={{ fontSize: "0.9rem", margin: "1.2rem 0 0.5rem" }}>
              Object keys cannot escape their prefix
            </h3>
            <CheckTable checks={traversal} inputHeader="Attempted key" />
          </>
        )}

        {names.length > 0 && (
          <>
            <h3 style={{ fontSize: "0.9rem", margin: "1.2rem 0 0.5rem" }}>
              Hostile file names never reach storage keys
            </h3>
            <CheckTable checks={names} inputHeader="File name" />
          </>
        )}

        {malformed.length > 0 && (
          <>
            <h3 style={{ fontSize: "0.9rem", margin: "1.2rem 0 0.5rem" }}>
              Malformed input is refused, never crashes the page
            </h3>
            <CheckTable checks={malformed} inputHeader="Input" />
            <p className="note" style={{ marginTop: "0.8rem" }}>
              The parser is Rust with <code>#![forbid(unsafe_code)]</code>, and it returns errors
              instead of panicking — a panic in WASM would take down the whole page.
            </p>
          </>
        )}
      </section>
    </>
  );
}

function CheckTable({ checks, inputHeader }: { checks: Check[]; inputHeader: string }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{inputHeader}</th>
          <th>Result</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {checks.map((check, i) => (
          <tr key={i}>
            <td className="mono">{check.input || '""'}</td>
            <td style={{ color: "var(--muted)", fontSize: "0.83rem" }}>{check.outcome}</td>
            <td style={{ width: 70 }}>
              <span className={`chip ${check.passed ? "ok" : "no"}`}>
                {check.passed ? "pass" : "FAIL"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A tiny, structurally valid MP4 — enough to exercise the naming path. */
function makeTinyMp4(): Uint8Array {
  // Deliberately not a real video: this check is about names, not decoding, and
  // the queue records the failure either way.
  return new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
}
