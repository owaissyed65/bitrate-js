import * as bitrate from "bitrate-js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

// Exposed so the library can be exercised from the devtools console while
// developing the showcase.
(globalThis as unknown as { bitrate: typeof bitrate }).bitrate = bitrate;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
