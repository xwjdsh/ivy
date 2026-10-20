import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

// In the app's window (not a browser), the sidebar shows the window's material through.
if ("mygo" in window) document.documentElement.dataset.shell = "app";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
