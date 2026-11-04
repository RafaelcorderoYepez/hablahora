// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME_ADMIN, ME_STAFF, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

// ---------- datos de ejemplo ----------

const CONV = "00000000-0000-4000-8000-0000000000c1";
const BUSINESS = {
  name: "Salón Aurora",
  locationName: "Brickell",
  address: null,
  timezone: "America/New_York",
  country: "US",
  currency: "USD",
  defaultLocale: "es",
  agentTone: "warm",
  agentInstructions: null,
  agentInstructionsEn: null,
  agentHandoff: null,
  agentHandoffEn: null,
  webChatSlug: "salon-aurora",
  chatEnabled: true,
  chatSettings: { palette: "rosa", accent: null, appearance: "auto", welcome: { es: null, en: null } },
};

function summary(over: Record<string, unknown> = {}) {
  return {
    id: CONV,
    channel: "web",
    customer: { name: "Rosa Díaz", phone: "+13055550001", email: "rosa@example.com" },
    verifiedEmail: null,
    handoff: true,
    handoffReason: "Quiere un presupuesto para novias",
    lastMessage: "Te comunico con el equipo.",
    lastCustomerMessageAt: "2026-10-12T16:00:00.000Z",
    updatedAt: "2026-10-12T16:00:05.000Z",
    bookingsCount: 0,
    ...over,
  };
}

const msg = (id: number, author: string, text: string, at: string, authorUserId: string | null = null) => ({
  id,
  role: author === "customer" ? "user" : "assistant",
  author,
  authorUserId,
  content: [{ type: "text", text }],
  createdAt: at,
});

function detail(over: { conversation?: Record<string, unknown>; extra?: unknown[] } = {}) {
  return {
    conversation: summary(over.conversation),
    bookings: [],
    trace: {
      messages: [
        msg(1, "customer", "Necesito un presupuesto para mi boda", "2026-10-12T16:00:00.000Z"),
        msg(2, "agent", "Te comunico con el equipo.", "2026-10-12T16:00:05.000Z"),
        ...(over.extra ?? []),
      ],
      llmCalls: [
        {
          id: 10,
          turnId: "t1",
          model: "claude-sonnet-5-5",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          durationMs: 900,
          stopReason: "tool_use",
          error: null,
          createdAt: "2026-10-12T16:00:02.000Z",
          toolCalls: [
            {
              id: 20,
              toolUseId: "tu1",
              name: "request_human",
              input: { reason: "Quiere un presupuesto para novias" },
              result: { handed_off: true },
              isError: false,
              durationMs: 12,
              createdAt: "2026-10-12T16:00:03.000Z",
            },
          ],
        },
      ],
    },
  };
}

const ORG = {
  id: "org1",
  name: "Salón Aurora",
  members: [
    { id: "m1", userId: "u-valeria", role: "owner", user: { id: "u-valeria", name: "Valeria Ríos", email: "valeria@salon-aurora.test" } },
    { id: "m2", userId: "u-camila", role: "member", user: { id: "u-camila", name: "Camila", email: "camila@salon-aurora.test" } },
  ],
  invitations: [],
};

function api(extra: Record<string, Handler> = {}, me: object = ME_ADMIN) {
  mockApi({
    "GET /api/me": () => me,
    "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
    "GET /api/merchant/business": () => BUSINESS,
    "GET /api/merchant/handoff/count": () => ({ count: 1 }),
    "GET /api/merchant/conversations": (_b, url) => ({
      items: url.searchParams.get("handoff") === "true" ? [summary()] : [summary(), summary({ id: "00000000-0000-4000-8000-0000000000c2", handoff: false, customer: null, bookingsCount: 2, lastMessage: "Listo, quedó confirmada." })],
      nextCursor: null,
    }),
    [`GET /api/merchant/conversations/${CONV}`]: () => detail(),
    "GET /api/auth/organization/get-full-organization": () => ORG,
    "GET /api/auth/organization/list": () => [],
    ...extra,
  });
}

beforeEach(setupBrowser);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversaciones", () => {
  it("listado con las que esperan al equipo y contador en el menú", async () => {
    api();
    renderAt("/conversaciones");
    expect(await screen.findByText("Cliente sin identificar")).toBeTruthy();
    expect(screen.getByText("2 reservas")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Menú" });
    expect(await within(nav).findByLabelText("1 Esperan al equipo")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Esperan al equipo/ }));
    expect(await screen.findByText("Rosa Díaz")).toBeTruthy();
    expect(screen.queryByText("Cliente sin identificar")).toBeNull();
  });

  it("detalle: la conversación, la traza con las herramientas y el motivo del paso al equipo", async () => {
    api();
    renderAt(`/conversaciones/${CONV}`);
    expect(await screen.findByRole("heading", { name: "Rosa Díaz" })).toBeTruthy();
    expect(screen.getByText(/Esta conversación espera al equipo/)).toBeTruthy();
    expect(screen.getByText("Motivo: Quiere un presupuesto para novias")).toBeTruthy();
    expect(screen.getByText("Necesito un presupuesto para mi boda")).toBeTruthy();
    expect(screen.queryByText("request_human")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ver traza" }));
    expect(screen.getByText("request_human")).toBeTruthy();
    expect(screen.getByText(/"handed_off": true/)).toBeTruthy();
  });

  it("el staff responde: aparece con su nombre y se limpia el cuadro", async () => {
    api(
      {
        [`POST /api/merchant/conversations/${CONV}/reply`]: (body) =>
          detail({ extra: [msg(3, "staff", body.text, "2026-10-12T16:02:00.000Z", "u-camila")] }),
      },
      ME_STAFF,
    );
    renderAt(`/conversaciones/${CONV}`);
    const box = (await screen.findByLabelText("Tu respuesta")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hola, soy Camila. ¿Para cuántas personas?" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Respuesta enviada.")).toBeTruthy();
    expect(await screen.findByText("Hola, soy Camila. ¿Para cuántas personas?")).toBeTruthy();
    expect(await screen.findByText("Equipo · Camila")).toBeTruthy();
    expect(box.value).toBe("");
    expect(sent("POST", `/api/merchant/conversations/${CONV}/reply`)[0].body).toEqual({ text: "Hola, soy Camila. ¿Para cuántas personas?" });
  });

  it("devolver al agente y volver a tomarla", async () => {
    api({
      [`POST /api/merchant/conversations/${CONV}/release`]: () => detail({ conversation: { handoff: false, handoffReason: null } }),
      [`POST /api/merchant/conversations/${CONV}/take`]: () => detail({ conversation: { handoffReason: "staff:u-valeria" } }),
    });
    renderAt(`/conversaciones/${CONV}`);
    fireEvent.click(await screen.findByRole("button", { name: "Devolver al agente" }));
    expect(await screen.findByText("El agente vuelve a atender esta conversación.")).toBeTruthy();
    expect(screen.queryByLabelText("Tu respuesta")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tomar conversación" }));
    expect(await screen.findByText("Tomaste la conversación. El agente ya no responde.")).toBeTruthy();
    expect(await screen.findByText("La tomó alguien del equipo.")).toBeTruthy();
    expect(screen.getByLabelText("Tu respuesta")).toBeTruthy();
  });

  it("el contexto que recibió el agente solo se ve con la traza abierta", async () => {
    const context = { ...msg(5, "system", "Hoy es lunes 12 de octubre, son las 12:00.", "2026-10-12T16:00:01.000Z"), role: "system" };
    api({ [`GET /api/merchant/conversations/${CONV}`]: () => detail({ extra: [context] }) });
    renderAt(`/conversaciones/${CONV}`);
    await screen.findByText("Necesito un presupuesto para mi boda");
    expect(screen.queryByText(/son las 12:00/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ver traza" }));
    expect(screen.getByText("Contexto para el agente")).toBeTruthy();
    expect(screen.getByText(/son las 12:00/)).toBeTruthy();
  });

  it("un error se explica en el idioma de la consola", async () => {
    api({
      [`GET /api/merchant/conversations/${CONV}`]: () => detail(),
      [`POST /api/merchant/conversations/${CONV}/reply`]: () => json({ error: "conflict", reason: "not_in_handoff", message: "x" }, 409),
    });
    renderAt(`/conversaciones/${CONV}`);
    fireEvent.change(await screen.findByLabelText("Tu respuesta"), { target: { value: "Hola" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Toma la conversación antes de responder.")).toBeTruthy();
  });
});
