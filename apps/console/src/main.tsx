import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";
import { startMonitoring } from "./monitoring.js";

void startMonitoring();

// La consola sigue el modo claro u oscuro del dispositivo.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", media.matches);
applyScheme();
media.addEventListener("change", applyScheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
