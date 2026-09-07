import { useState } from "react";

import { CapabilitiesPanel } from "./components/CapabilitiesPanel";
import { PackagePanel } from "./components/PackagePanel";
import { QueuePanel } from "./components/QueuePanel";
import { ResumePanel } from "./components/ResumePanel";
import { SecurityPanel } from "./components/SecurityPanel";

const TABS = [
  { id: "package", label: "Package a video", element: <PackagePanel /> },
  { id: "queue", label: "Queue & upload", element: <QueuePanel /> },
  { id: "resume", label: "Resume", element: <ResumePanel /> },
  { id: "capabilities", label: "Capabilities", element: <CapabilitiesPanel /> },
  { id: "security", label: "Security", element: <SecurityPanel /> },
] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("package");

  return (
    <div className="shell">
      <header className="masthead">
        <h1>bitrate</h1>
        <p>
          Chunk, transcode and package video into HLS entirely in the browser. Everything below
          runs the real library in this tab — no server, and nothing leaves your machine.
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Panels are kept mounted so switching tabs does not discard work. */}
      {TABS.map((t) => (
        <div key={t.id} hidden={tab !== t.id}>
          {t.element}
        </div>
      ))}
    </div>
  );
}
