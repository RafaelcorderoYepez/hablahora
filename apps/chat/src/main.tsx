import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { PrivacyPage } from "./Privacy.js";
import "./index.css";
import { startMonitoring } from "./monitoring.js";

void startMonitoring();

// Una página por negocio: el slug es el primer tramo del camino (/salon-aurora).
const slug = decodeURIComponent(window.location.pathname.split("/").filter(Boolean)[0] ?? "");
// ?embed=1: dentro del panel que abre embed.js en el sitio del negocio
const embedded = new URLSearchParams(window.location.search).get("embed") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{slug === "privacidad" ? <PrivacyPage /> : <App slug={slug} embedded={embedded} />}</StrictMode>,
);
