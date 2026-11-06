// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { PrivacyPage } from "./Privacy.js";
import { HANDOFF_POLL_MS } from "./useChat.js";

const SLUG = "salon-aurora";
const SESSION = "S".repeat(22);
const INFO = {
  name: "Salón Aurora",
  available: true,
  locale: "es",
  accent: "#B4416A",
  appearance: "light",
  tint: true,
  texture: "dots",
  welcome: { es: "¡Hola! Soy el asistente del Salón Aurora.", en: "Hi! I'm Salón Aurora's assistant." },
  logoUrl: null,
  privacy: false,
};

type Sse = [event: string, data: object][];
const sse = (events: Sse) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** API simulada: responde según la ruta y guarda lo que recibió. */
function mockApi(opts: {
  info?: Response;
  transcript?: Response;
  /** respuestas sucesivas del historial (la última se repite) */
  transcripts?: (() => Response)[];
  replies?: Response[];
}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const replies = [...(opts.replies ?? [])];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && url === `/api/chat/${SLUG}`) return opts.info ?? json(INFO);
    if (method === "GET" && url.endsWith("/messages")) {
      if (opts.transcripts?.length) return (opts.transcripts.length > 1 ? opts.transcripts.shift()! : opts.transcripts[0])();
      return opts.transcript ?? json({}, 404);
    }
    if (method === "POST" && url.endsWith("/sessions")) return json({ sessionId: SESSION, locale: "es" }, 201);
    if (method === "POST" && url.endsWith("/messages")) return replies.shift() ?? json({}, 500);
    return json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
async function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /enviar|send/i }));
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "languages", { value: ["es-MX"], configurable: true });
  document.documentElement.className = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chat público", () => {
  it("muestra el negocio con su color y su bienvenida", async () => {
    mockApi({});
    render(<App slug={SLUG} />);
    expect(await screen.findByRole("heading", { name: "Salón Aurora" })).toBeTruthy();
    expect(screen.getByText(INFO.welcome.es)).toBeTruthy();
    expect(screen.getByText("SA")).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue("--ui-accent-light")).toBe("#B4416A");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    const shell = screen.getByRole("main");
    expect(shell.classList.contains("chat-backdrop")).toBe(true);
    expect(shell.dataset).toMatchObject({ tint: "true", texture: "dots" });
  });

  it("al escribir abre la sesión, muestra la respuesta en partes y separa lo que dice antes y después de una herramienta", async () => {
    const calls = mockApi({
      replies: [
        sse([
          ["text", { text: "Déjame " }],
          ["text", { text: "revisar." }],
          ["tool", { name: "check_availability" }],
          ["text", { text: "Tengo el miércoles a las 11:00." }],
          ["done", {}],
        ]),
      ],
    });
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]); // ver la página no crea sesiones

    await type("¿Tienen hora el miércoles?");
    expect(await screen.findByText("Tengo el miércoles a las 11:00.")).toBeTruthy();
    expect(screen.getByText("Déjame revisar.")).toBeTruthy();
    expect(screen.getByText("¿Tienen hora el miércoles?")).toBeTruthy();

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([
      `/api/chat/${SLUG}/sessions`,
      `/api/chat/${SLUG}/sessions/${SESSION}/messages`,
    ]);
    expect(posts[0].body).toEqual({ locale: "es" });
    expect(posts[1].body).toEqual({ text: "¿Tienen hora el miércoles?", locale: "es" });
    expect(JSON.parse(localStorage.getItem(`hablahora-chat:${SLUG}`)!).sessionId).toBe(SESSION);
    expect(box().value).toBe("");
  });

  it("avisa cuando la conversación pasa a una persona", async () => {
    mockApi({ replies: [sse([["handoff", {}], ["text", { text: "Te comunico con el equipo." }], ["done", {}]])] });
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    await type("Quiero hablar con alguien");
    expect(await screen.findByText(/Una persona del equipo seguirá esta conversación/)).toBeTruthy();
  });

  it("al llegar al límite de mensajes avisa, marca el mensaje y devuelve el texto al cuadro", async () => {
    mockApi({ replies: [json({ error: "session_limit" }, 429)] });
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    await type("Otro mensaje");
    expect(await screen.findByText(/llegó a su límite de mensajes/)).toBeTruthy();
    expect(screen.getByText("No se envió")).toBeTruthy();
    await waitFor(() => expect(box().value).toBe("Otro mensaje"));
  });

  it("el selector de idioma cambia la interfaz y se manda con el mensaje", async () => {
    const calls = mockApi({ replies: [sse([["text", { text: "Sure!" }], ["done", {}]])] });
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });

    fireEvent.click(screen.getByRole("button", { name: "en" }));
    expect(screen.getByText(INFO.welcome.en)).toBeTruthy();
    expect(box().placeholder).toBe("Type your message");
    expect(document.documentElement.lang).toBe("en");

    await type("Hi");
    await screen.findByText("Sure!");
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/messages"))!;
    expect(post.body).toEqual({ text: "Hi", locale: "en" });
    expect(JSON.parse(localStorage.getItem(`hablahora-chat:${SLUG}`)!).locale).toBe("en");
  });

  it("detecta el inglés del navegador", async () => {
    Object.defineProperty(navigator, "languages", { value: ["en-US"], configurable: true });
    mockApi({});
    render(<App slug={SLUG} />);
    expect(await screen.findByText(INFO.welcome.en)).toBeTruthy();
  });

  it("al recargar retoma la conversación guardada", async () => {
    localStorage.setItem(`hablahora-chat:${SLUG}`, JSON.stringify({ sessionId: SESSION }));
    mockApi({
      transcript: json({
        locale: "es",
        handoff: true,
        messages: [
          { role: "customer", text: "Hola", at: "2026-10-12T16:00:00Z" },
          { role: "agent", text: "¡Hola! ¿Qué necesitas?", at: "2026-10-12T16:00:02Z" },
        ],
      }),
    });
    render(<App slug={SLUG} />);
    expect(await screen.findByText("¡Hola! ¿Qué necesitas?")).toBeTruthy();
    expect(screen.getByText("Hola")).toBeTruthy();
    expect(screen.getByText(/Una persona del equipo/)).toBeTruthy();
  });

  it("con el equipo a cargo, sus respuestas llegan solas; al devolverla al agente se quita el aviso", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    localStorage.setItem(`hablahora-chat:${SLUG}`, JSON.stringify({ sessionId: SESSION }));
    const base = [
      { role: "customer", text: "Quiero hablar con alguien", at: "2026-10-12T16:00:00Z" },
      { role: "agent", text: "Te comunico con el equipo.", at: "2026-10-12T16:00:02Z" },
    ];
    const staff = { role: "staff", text: "Hola, soy Valeria. ¿En qué te ayudo?", at: "2026-10-12T16:01:00Z" };
    mockApi({
      transcripts: [
        () => json({ locale: "es", handoff: true, messages: base }),
        () => json({ locale: "es", handoff: true, messages: [...base, staff] }),
        () => json({ locale: "es", handoff: false, messages: [...base, staff] }),
      ],
    });
    try {
      render(<App slug={SLUG} />);
      expect(await screen.findByText(/Una persona del equipo/)).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(HANDOFF_POLL_MS);
      });
      expect(await screen.findByText("Hola, soy Valeria. ¿En qué te ayudo?")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(HANDOFF_POLL_MS);
      });
      await waitFor(() => expect(screen.queryByText(/Una persona del equipo/)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("si la sesión guardada ya no existe, abre otra y reenvía el mensaje", async () => {
    localStorage.setItem(`hablahora-chat:${SLUG}`, JSON.stringify({ sessionId: "V".repeat(22) }));
    const calls = mockApi({
      transcript: json({ locale: "es", handoff: false, messages: [] }),
      replies: [json({ error: "not_found" }, 404), sse([["text", { text: "Listo." }], ["done", {}]])],
    });
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    await type("Hola");
    expect(await screen.findByText("Listo.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.split("/").slice(-2).join("/"))).toEqual([
      `${"V".repeat(22)}/messages`,
      `${SLUG}/sessions`,
      `${SESSION}/messages`,
    ]);
  });

  it("si el negocio no activó su chat, lo dice y no abre sesiones", async () => {
    const calls = mockApi({ info: json({ ...INFO, available: false }) });
    render(<App slug={SLUG} />);
    expect(await screen.findByText("Este chat todavía no está disponible")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("si se desactiva mientras alguien escribe, pasa al aviso de no disponible", async () => {
    mockApi({ replies: [json({ error: "chat_unavailable" }, 409)] });
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    await type("Hola");
    expect(await screen.findByText("Este chat todavía no está disponible")).toBeTruthy();
  });

  it("incrustado: el botón cerrar avisa a la página del negocio", async () => {
    mockApi({});
    const post = vi.spyOn(window.parent, "postMessage");
    render(<App slug={SLUG} embedded />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar chat" }));
    expect(post).toHaveBeenCalledWith({ type: "hablahora-chat:close" }, "*");
  });

  it("un enlace que no existe lo dice", async () => {
    mockApi({ info: json({ error: "not_found" }, 404) });
    render(<App slug="no-existe" />);
    expect(await screen.findByText("Este chat no existe")).toBeTruthy();
  });
});

describe("logo y privacidad", () => {
  it("con logo se ve el logo en lugar de las iniciales; con aviso, el enlace a privacidad", async () => {
    mockApi({ info: json({ ...INFO, logoUrl: "/api/chat/salon-aurora/logo?v=1", privacy: true }) });
    const { container } = render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    expect(container.querySelector("header img")?.getAttribute("src")).toBe("/api/chat/salon-aurora/logo?v=1");
    expect(screen.queryByText("SA")).toBeNull();
    const link = screen.getByRole("link", { name: "Privacidad" });
    expect(link.getAttribute("href")).toBe("/privacidad?lang=es");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("sin logo, las iniciales; sin aviso, no hay enlace", async () => {
    mockApi({});
    render(<App slug={SLUG} />);
    await screen.findByRole("heading", { name: "Salón Aurora" });
    expect(screen.getByText("SA")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Privacidad" })).toBeNull();
  });

  it("la página de privacidad muestra el texto en el idioma pedido o, si falta, en el otro", async () => {
    window.history.replaceState(null, "", "/privacidad?lang=en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ es: "Usamos tus datos solo para tu reserva.", en: null, updatedAt: "2026-10-19T12:00:00.000Z" })),
    );
    try {
      render(<PrivacyPage />);
      expect(await screen.findByText("Usamos tus datos solo para tu reserva.")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Privacy notice" })).toBeTruthy();
      expect(screen.getByText("Updated October 19, 2026")).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
