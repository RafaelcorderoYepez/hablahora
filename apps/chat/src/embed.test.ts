// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** embed.js tal como lo sirve el chat (public/), ejecutado en una página "del negocio". */
// en jsdom import.meta.url no es una ruta de archivo: se busca desde donde corre vitest
const EMBED = ["apps/chat/public/embed.js", "public/embed.js"].map((p) => join(process.cwd(), p)).find(existsSync)!;
const SOURCE = readFileSync(EMBED, "utf8");

function loadEmbed() {
  delete (window as any).__hablahoraChatEmbed;
  new Function(SOURCE)(); // define window.HablaHoraChatEmbed (sin currentScript no arranca solo)
  const script = document.createElement("script");
  script.src = "https://chat.hablahora.test/embed.js";
  script.setAttribute("data-slug", "salon-aurora");
  return (window as any).HablaHoraChatEmbed.init(script) as Promise<void>;
}

const info = (available = true) =>
  new Response(JSON.stringify({ name: "Salón Aurora", available, locale: "es", accent: "#B4416A", appearance: "auto", tint: false, texture: "none", welcome: {} }), {
    status: 200,
  });

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "language", { value: "es-MX", configurable: true });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("embed.js", () => {
  it("agrega el botón del color del negocio y abre el chat en un panel", async () => {
    const fetchMock = vi.fn(async () => info());
    vi.stubGlobal("fetch", fetchMock);
    await loadEmbed();
    expect(fetchMock).toHaveBeenCalledWith("https://chat.hablahora.test/api/chat/salon-aurora");

    const button = document.querySelector('[data-hablahora-chat="button"]') as HTMLButtonElement;
    const panel = document.querySelector('[data-hablahora-chat="panel"]') as HTMLDivElement;
    expect(button.getAttribute("aria-label")).toBe("Abrir el chat de Salón Aurora");
    expect(button.style.background).toMatch(/rgb\(180, 65, 106\)|#B4416A/i);
    expect(panel.style.display).toBe("none");
    expect(panel.querySelector("iframe")).toBeNull(); // el chat se carga recién al abrir

    button.click();
    expect(panel.style.display).toBe("block");
    expect(panel.querySelector("iframe")!.getAttribute("src")).toBe("https://chat.hablahora.test/salon-aurora?embed=1");
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // el chat incrustado pide cerrar
    window.dispatchEvent(new MessageEvent("message", { origin: "https://chat.hablahora.test", data: { type: "hablahora-chat:close" } }));
    expect(panel.style.display).toBe("none");
    // un mensaje de otro origen no hace nada
    button.click();
    window.dispatchEvent(new MessageEvent("message", { origin: "https://otro.example", data: { type: "hablahora-chat:close" } }));
    expect(panel.style.display).toBe("block");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.style.display).toBe("none");
  });

  it("si el chat del negocio no está activo, no agrega nada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => info(false)));
    await loadEmbed();
    expect(document.querySelector("[data-hablahora-chat]")).toBeNull();
  });

  it("si la API no responde, el sitio sigue igual", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("sin red"))));
    await loadEmbed();
    expect(document.querySelector("[data-hablahora-chat]")).toBeNull();
  });
});
