// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentMonths } from "./routes/platform/Usage.js";
import { json, ME_ADMIN, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

const ME_PLATFORM = {
  user: { id: "u-admin", name: "Admin HablaHora", email: "admin@hablahora.test", locale: null },
  platformAdmin: true,
  business: null,
};
const AURORA = "00000000-0000-4000-8000-0000000000b1";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const PRO = { id: "00000000-0000-4000-8000-0000000000a2", name: "Profesional" };

const BUSINESS = {
  id: AURORA,
  name: "Salón Aurora",
  vertical: "salon",
  country: "CL",
  currency: "CLP",
  status: "active",
  statusChangedAt: null,
  plan: PRO,
  agentModel: null,
  slug: "salon-aurora",
  chatEnabled: true,
  owner: { name: "Valeria", email: "valeria@salon-aurora.test" },
  createdAt: "2026-10-01T12:00:00.000Z",
  usage: { conversationsThisMonth: 42, maxConversationsPerMonth: 1500, activeStaff: 3, maxActiveStaff: 10 },
};

const usageRow = (over: Record<string, unknown>) => ({
  id: AURORA,
  name: "Salón Aurora",
  status: "active",
  plan: PRO,
  conversations: 40,
  maxConversationsPerMonth: 50,
  llmCalls: 120,
  inputTokens: 1_200_000,
  outputTokens: 80_000,
  cacheReadTokens: 400_000,
  cacheWriteTokens: 50_000,
  costUsd: 3.2,
  costPerConversationUsd: 0.08,
  unpricedCalls: 0,
  ...over,
});

const USAGE = {
  month: "2026-10",
  totals: { conversations: 45, llmCalls: 130, inputTokens: 1_300_000, outputTokens: 90_000, cacheReadTokens: 400_000, cacheWriteTokens: 50_000, costUsd: 3.5 },
  businesses: [
    usageRow({}),
    usageRow({ id: "00000000-0000-4000-8000-0000000000b2", name: "Barbería Norte", conversations: 5, maxConversationsPerMonth: null, costUsd: 0.3, costPerConversationUsd: 0.06, unpricedCalls: 2 }),
    usageRow({ id: "00000000-0000-4000-8000-0000000000b3", name: "Sin actividad", conversations: 0, llmCalls: 0, costUsd: 0, costPerConversationUsd: null }),
  ],
};

const HEALTH = {
  windowDays: 7,
  waitThresholdMin: 15,
  agent: { calls: 200, errors: 4, errorRate: 0.02, p50Ms: 1800, p95Ms: 6200 },
  tools: { calls: 90, errors: 3, errorRate: 3 / 90, failing: [{ name: "hold_slot", calls: 30, errors: 3 }] },
  waiting: [{ tenantId: AURORA, tenantName: "Salón Aurora", conversationId: CONV, waitingMin: 75, reason: "Quiere un presupuesto para novias" }],
  byBusiness: [{ id: AURORA, name: "Salón Aurora", calls: 200, errors: 4, errorRate: 0.02, p95Ms: 6200 }],
};

const conversationSummary = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  channel: "web",
  customer: { name: "Rosa Díaz", phone: null, email: null },
  verifiedEmail: null,
  handoff: true,
  handoffReason: "Quiere un presupuesto",
  lastMessage: "Necesito un presupuesto para mi boda",
  lastCustomerMessageAt: "2026-10-19T12:00:00.000Z",
  updatedAt: "2026-10-19T12:00:00.000Z",
  bookingsCount: 0,
  ...over,
});

const DETAIL = {
  conversation: conversationSummary(),
  bookings: [],
  trace: {
    messages: [
      { id: 1, role: "user", author: "customer", authorUserId: null, content: [{ type: "text", text: "Necesito un presupuesto para mi boda" }], createdAt: "2026-10-19T12:00:00.000Z" },
    ],
    llmCalls: [
      {
        id: 10,
        turnId: "t1",
        model: "claude-sonnet-5-5",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 900,
        stopReason: "tool_use",
        error: null,
        createdAt: "2026-10-19T12:00:02.000Z",
        toolCalls: [{ id: 20, toolUseId: "tu1", name: "request_human", input: {}, result: { handed_off: true }, isError: false, durationMs: 12, createdAt: "2026-10-19T12:00:03.000Z" }],
      },
    ],
  },
};

function api(extra: Record<string, Handler> = {}, me: object = ME_PLATFORM) {
  mockApi({
    "GET /api/me": () => me,
    "GET /api/platform/businesses": () => [BUSINESS],
    "GET /api/platform/usage": (_b, url) => ({ ...USAGE, month: url.searchParams.get("month") }),
    "GET /api/platform/health": () => HEALTH,
    "GET /api/platform/overview": (_b, url) => ({
      from: "2026-09-20",
      to: "2026-10-19",
      businesses: { total: 3, active: 2, suspended: 1, closed: 0 },
      totals: { conversations: 120, bookings: 45, errors: 7 },
      days: [{ date: "2026-10-19", conversations: 12, bookings: 4, errors: Number(url.searchParams.get("days")) }],
    }),
    "GET /api/platform/support/log": () => ({
      items: [
        { id: 2, at: "2026-10-19T14:00:00.000Z", business: { id: AURORA, name: "Salón Aurora" }, user: { id: "u-admin", name: "Admin HablaHora", email: "admin@hablahora.test" }, reason: "Ticket 99: revisar traza", conversationId: CONV },
        { id: 1, at: "2026-10-19T13:00:00.000Z", business: { id: AURORA, name: "Salón Aurora" }, user: null, reason: "Ticket 98", conversationId: null },
      ],
      nextCursor: null,
    }),
    "GET /api/auth/organization/list": () => [],
    ...extra,
  });
}

beforeEach(setupBrowser);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("panel general", () => {
  it("negocios por estado, totales del período y cambio de período", async () => {
    api();
    renderAt("/plataforma");
    expect(await screen.findByText("2 activos de 3", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("1 suspendidos · 0 dados de baja")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("45")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conversaciones y reservas por día" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Últimos 7 días" }));
    await waitFor(() => expect(sent("GET", "/api/platform/overview").length).toBe(2));
    expect(sent("GET", "/api/platform/overview")).toHaveLength(2);
  });
});

describe("uso y costo", () => {
  it("costo por negocio contra el plan, aviso de llamadas sin precio y cambio de mes", async () => {
    api();
    renderAt("/plataforma/uso");
    expect(await screen.findByText("US$3,50")).toBeTruthy(); // total del mes
    const table = screen.getByRole("table");
    expect(within(table).getByText("40 / 50")).toBeTruthy();
    expect(within(table).getByText("US$3,20")).toBeTruthy();
    expect(within(table).getByText("US$0,08")).toBeTruthy();
    expect(within(table).getAllByText("1.2M entrada · 80K salida")).toHaveLength(2);
    expect(within(table).queryByText("Sin actividad")).toBeNull();
    expect(screen.getAllByText(/2 llamadas sin precio/).length).toBeGreaterThan(0);

    const months = recentMonths(new Date());
    fireEvent.change(screen.getByLabelText("Mes"), { target: { value: months[1] } });
    await waitFor(() => {
      const asked = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => String(u));
      expect(asked.some((u) => u.includes(`/api/platform/usage?month=${months[1]}`))).toBe(true);
    });
  });

  it("los meses recientes, el actual primero", () => {
    expect(recentMonths(new Date("2026-02-10T12:00:00Z"), 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});

describe("salud", () => {
  it("latencia, errores, herramientas que fallan y conversaciones sin atender con enlace a soporte", async () => {
    api();
    renderAt("/plataforma/salud");
    expect(await screen.findByText("1.8 s")).toBeTruthy();
    expect(screen.getByText("mediana · p95 6.2 s")).toBeTruthy();
    expect(screen.getByText("2 %")).toBeTruthy(); // errores del modelo
    expect(screen.getByText("4 de 200")).toBeTruthy();
    expect(screen.getByText("hold_slot")).toBeTruthy();
    expect(screen.getByText("1 h 15 min")).toBeTruthy();
    expect(screen.getByText("Quiere un presupuesto para novias")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver en soporte" }).getAttribute("href")).toContain(`negocio=${AURORA}`);
  });
});

describe("soporte", () => {
  const listUrl = `/api/platform/support/businesses/${AURORA}/conversations`;

  it("sin motivo no entra; con motivo lista, abre una conversación (solo lectura) y manda el motivo cada vez", async () => {
    api({
      [`POST ${listUrl}`]: () => ({ items: [conversationSummary()], nextCursor: null }),
      [`POST ${listUrl}/${CONV}`]: () => DETAIL,
    });
    renderAt("/plataforma/soporte");
    await screen.findByRole("option", { name: "Salón Aurora" });
    fireEvent.change(screen.getByLabelText("Negocio"), { target: { value: AURORA } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver conversaciones" }));
    expect(await screen.findByText("Escribe el motivo (al menos 5 caracteres).")).toBeTruthy();
    expect(sent("POST", listUrl)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Ticket 99: revisar traza" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver conversaciones" }));
    fireEvent.click(await screen.findByRole("button", { name: /Rosa Díaz/ }));
    expect(await screen.findByText("Solo lectura: desde aquí no se responde ni se cambia nada.")).toBeTruthy();
    expect(screen.getByText("Necesito un presupuesto para mi boda")).toBeTruthy();
    expect(screen.getByText("request_human")).toBeTruthy(); // la traza arranca abierta
    expect(screen.queryByLabelText("Tu respuesta")).toBeNull();
    expect(screen.queryByRole("button", { name: "Tomar conversación" })).toBeNull();

    expect(sent("POST", listUrl)[0].body).toEqual({ reason: "Ticket 99: revisar traza" });
    expect(sent("POST", `${listUrl}/${CONV}`)[0].body).toEqual({ reason: "Ticket 99: revisar traza" });

    fireEvent.click(screen.getByRole("button", { name: "Conversaciones del negocio" }));
    expect(await screen.findByRole("button", { name: /Rosa Díaz/ })).toBeTruthy();
  });

  it("llega con el negocio elegido desde Salud; un error se explica", async () => {
    api({ [`POST ${listUrl}`]: () => json({ error: "not_found", reason: "not_found", message: "x" }, 404) });
    renderAt(`/plataforma/soporte?negocio=${AURORA}`);
    await screen.findByRole("option", { name: "Salón Aurora" });
    expect((screen.getByLabelText("Negocio") as HTMLSelectElement).value).toBe(AURORA);
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Ticket 100: soporte" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver conversaciones" }));
    expect(await screen.findByText("No se encontró. Revisa el negocio o la conversación.")).toBeTruthy();
  });

  it("registro de accesos: quién, cuándo, a qué negocio y qué vio", async () => {
    api();
    renderAt("/plataforma/soporte");
    fireEvent.click(await screen.findByRole("tab", { name: "Registro de accesos" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Ticket 99: revisar traza")).toBeTruthy();
    expect(within(table).getByText("admin@hablahora.test")).toBeTruthy();
    expect(within(table).getByText("Una conversación")).toBeTruthy();
    expect(within(table).getByText("El listado de conversaciones")).toBeTruthy();
  });
});

describe("negocio suspendido: usuarios y configuración en solo lectura", () => {
  const merchant = (status: string) =>
    mockApi({
      "GET /api/me": () => ({ ...ME_ADMIN, business: { ...ME_ADMIN.business, status } }),
      "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
      "GET /api/merchant/handoff/count": () => ({ count: 0 }),
      "GET /api/merchant/staff": () => [],
      "GET /api/merchant/services": () => [],
      "GET /api/merchant/hours": () => ({ schedule: [] }),
      "GET /api/auth/organization/list": () => [],
      "GET /api/auth/organization/get-full-organization": () => ({
        id: "org1",
        name: "Salón Aurora",
        members: [
          { id: "m1", userId: "u-valeria", role: "owner", user: { id: "u-valeria", name: "Valeria Ríos", email: "valeria@salon-aurora.test" } },
          { id: "m2", userId: "u-camila", role: "member", user: { id: "u-camila", name: "Camila", email: "camila@salon-aurora.test" } },
        ],
        invitations: [],
      }),
    });

  it("activo: se puede invitar y agregar; suspendido: no, y sin el aviso de rol de staff", async () => {
    merchant("active");
    renderAt("/usuarios");
    expect(await screen.findByRole("button", { name: "Enviar invitación" })).toBeTruthy();
    cleanup();

    merchant("suspended");
    renderAt("/usuarios");
    expect(await screen.findByText("Camila")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar invitación" })).toBeNull();
    expect(screen.queryByText(/Solo los administradores pueden invitar/)).toBeNull();
    expect(screen.getByText(/Tu negocio está suspendido/)).toBeTruthy();
    cleanup();

    renderAt("/equipo");
    await screen.findByRole("heading", { name: "Equipo" });
    expect(screen.queryByRole("button", { name: "Agregar" })).toBeNull();
    expect(screen.queryByText(/Tu rol es staff/)).toBeNull();
  });
});
