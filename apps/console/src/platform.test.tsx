// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME_ADMIN, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

// ---------- datos de ejemplo ----------

const ME_PLATFORM = {
  user: { id: "u-admin", name: "Admin HablaHora", email: "admin@hablahora.test", locale: null },
  platformAdmin: true,
  business: null,
};
const INICIAL = "00000000-0000-4000-8000-0000000000a1";
const PRO = "00000000-0000-4000-8000-0000000000a2";
const PLANS = [
  { id: INICIAL, name: "Inicial", maxConversationsPerMonth: 300, maxActiveStaff: 3, maxLocations: 1, isDefault: true, businesses: 0 },
  { id: PRO, name: "Profesional", maxConversationsPerMonth: 1500, maxActiveStaff: 10, maxLocations: 1, isDefault: false, businesses: 1 },
];
const AURORA_ID = "00000000-0000-4000-8000-0000000000b1";

function business(over: Record<string, unknown> = {}) {
  return {
    id: AURORA_ID,
    name: "Salón Aurora",
    vertical: "salon",
    country: "CL",
    currency: "CLP",
    status: "active",
    statusChangedAt: null,
    plan: { id: PRO, name: "Profesional" },
    agentModel: null,
    slug: "salon-aurora",
    chatEnabled: true,
    owner: { name: "Valeria", email: "valeria@salon-aurora.test" },
    createdAt: "2026-10-01T12:00:00.000Z",
    usage: { conversationsThisMonth: 42, maxConversationsPerMonth: 1500, activeStaff: 3, maxActiveStaff: 10 },
    ...over,
  };
}

const SETTINGS = { defaultModel: null, serverModel: "claude-sonnet-5-5", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] };
const USERS = [{ id: "u-admin", name: "Admin HablaHora", email: "admin@hablahora.test", createdAt: "2026-10-01T12:00:00.000Z" }];

function api(extra: Record<string, Handler> = {}, me: object = ME_PLATFORM) {
  mockApi({
    "GET /api/me": () => me,
    "GET /api/platform/businesses": () => [business()],
    "GET /api/platform/overview": () => ({
      from: "2026-09-20",
      to: "2026-10-19",
      businesses: { total: 2, active: 1, suspended: 1, closed: 0 },
      totals: { conversations: 10, bookings: 4, errors: 1 },
      days: [{ date: "2026-10-19", conversations: 10, bookings: 4, errors: 1 }],
    }),
    "GET /api/platform/plans": () => PLANS,
    "GET /api/platform/settings": () => SETTINGS,
    "GET /api/platform/users": () => USERS,
    "GET /api/auth/organization/list": () => [],
    ...extra,
  });
}

beforeEach(setupBrowser);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("consola de la plataforma", () => {
  it("el administrador sin negocio entra a la plataforma, por el panel", async () => {
    api();
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Panel" })).toBeTruthy();
    expect(screen.getByText("Plataforma")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Menú" });
    for (const name of ["Negocios", "Uso y costo", "Salud", "Soporte", "Planes", "Configuración", "Usuarios"]) {
      expect(within(nav).getByRole("link", { name })).toBeTruthy();
    }
    expect(within(nav).queryByRole("link", { name: "Agenda" })).toBeNull();
  });

  it("negocios con estado, plan y uso", async () => {
    api();
    renderAt("/plataforma/negocios");
    expect(await screen.findByRole("heading", { name: "Negocios" })).toBeTruthy();
    expect(await screen.findByText("Salón Aurora")).toBeTruthy();
    expect(screen.getByText("42 de 1500 conversaciones")).toBeTruthy();
    expect(screen.getByText("3 de 10 profesionales")).toBeTruthy();
  });

  it("un miembro de un negocio no entra a la plataforma", async () => {
    mockApi({
      "GET /api/me": () => ME_ADMIN,
      "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
      "GET /api/merchant/business": () => ({ timezone: "America/New_York" }),
      "GET /api/merchant/handoff/count": () => ({ count: 0 }),
      "GET /api/merchant/bookings": () => ({ items: [] }),
      "GET /api/auth/organization/list": () => [],
    });
    renderAt("/plataforma");
    expect(await screen.findByText(/Hola, Valeria/)).toBeTruthy();
    expect(sent("GET", "/api/platform/businesses")).toHaveLength(0);
  });

  it("alta: valida, manda plantilla, dueño y plan, y avisa a quién se envió el correo", async () => {
    api({
      "POST /api/platform/businesses": (body) =>
        json(business({ id: "00000000-0000-4000-8000-0000000000b2", name: body.name, owner: body.owner, vertical: "barbershop" }), 201),
    });
    renderAt("/plataforma/negocios");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo negocio" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Dar de alta" }));
    expect(await within(dialog).findByText("Escribe un correo válido.")).toBeTruthy();
    expect(sent("POST", "/api/platform/businesses")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Nombre del negocio"), { target: { value: "Barbería Norte" } });
    // Chile por defecto; al cambiar de país, la zona y el idioma lo siguen
    expect((within(dialog).getByLabelText("Zona horaria") as HTMLInputElement).value).toBe("America/Santiago");
    fireEvent.change(within(dialog).getByLabelText("País"), { target: { value: "US" } });
    expect((within(dialog).getByLabelText("Zona horaria") as HTMLInputElement).value).toBe("America/New_York");
    fireEvent.change(within(dialog).getByLabelText("País"), { target: { value: "CL" } });
    fireEvent.change(within(dialog).getByLabelText("Rubro"), { target: { value: "barberia" } });
    fireEvent.change(within(dialog).getByLabelText("Nombre del dueño"), { target: { value: "Marta" } });
    fireEvent.change(within(dialog).getByLabelText("Correo del dueño"), { target: { value: "marta@norte.test" } });
    await within(dialog).findByRole("option", { name: "Profesional" });
    fireEvent.change(within(dialog).getByLabelText("Plan"), { target: { value: PRO } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Dar de alta" }));
    expect(await screen.findByText("Negocio creado. Le enviamos el correo a marta@norte.test.")).toBeTruthy();
    expect(sent("POST", "/api/platform/businesses")[0].body).toEqual({
      name: "Barbería Norte",
      country: "CL",
      template: "barberia",
      owner: { name: "Marta", email: "marta@norte.test" },
      timezone: "America/Santiago",
      locale: "es",
      planId: PRO,
    });
  });

  it("detalle: cambiar modelo y suspender con confirmación", async () => {
    api({
      [`PATCH /api/platform/businesses/${AURORA_ID}`]: (body) => business(body.status ? { status: body.status } : { agentModel: body.agentModel }),
    });
    renderAt("/plataforma/negocios");
    fireEvent.click(await screen.findByRole("button", { name: /Salón Aurora/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: "El de la plataforma (claude-sonnet-5-5)" });
    fireEvent.change(within(dialog).getByLabelText("Modelo del agente"), { target: { value: "claude-haiku-5-5" } });
    await waitFor(() => expect(sent("PATCH", `/api/platform/businesses/${AURORA_ID}`)[0]?.body).toEqual({ agentModel: "claude-haiku-5-5" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("¿Suspender Salón Aurora?")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Suspender" }));
    expect(await screen.findByText("Negocio suspendido.")).toBeTruthy();
    expect(sent("PATCH", `/api/platform/businesses/${AURORA_ID}`)[1].body).toEqual({ status: "suspended" });
  });

  it("planes: vacío es sin límite; un número inválido se marca; nombre repetido se explica", async () => {
    let attempt = 0;
    api({
      "POST /api/platform/plans": (body) =>
        ++attempt === 1
          ? json({ error: "conflict", reason: "plan_name_taken", message: "x" }, 409)
          : json({ ...body, id: "00000000-0000-4000-8000-0000000000a3", businesses: 0 }, 201),
    });
    renderAt("/plataforma/planes");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo plan" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "Empresa" } });
    fireEvent.change(within(dialog).getByLabelText("Profesionales activos"), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await within(dialog).findByText("Escribe un número entero mayor que 0.")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Profesionales activos"), { target: { value: "50" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Ya hay un plan con ese nombre.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(sent("POST", "/api/platform/plans")).toHaveLength(2));
    expect(sent("POST", "/api/platform/plans")[1].body).toEqual({
      name: "Empresa",
      maxConversationsPerMonth: null,
      maxActiveStaff: 50,
      maxLocations: 1,
      isDefault: false,
    });
  });

  it("configuración: el modelo por defecto", async () => {
    api({ "PUT /api/platform/settings": (body) => ({ ...SETTINGS, defaultModel: body.defaultModel }) });
    renderAt("/plataforma/configuracion");
    const select = await screen.findByLabelText("Modelo por defecto del agente");
    fireEvent.change(select, { target: { value: "claude-opus-5-5" } });
    expect((await screen.findAllByText("Guardado.")).length).toBeGreaterThan(0);
    expect(sent("PUT", "/api/platform/settings")).toHaveLength(1);
    expect(sent("PUT", "/api/platform/settings")[0].body).toEqual({ defaultModel: "claude-opus-5-5" });
  });

  it("usuarios: invitar y error de correo repetido", async () => {
    let attempt = 0;
    api({
      "POST /api/platform/users": (body) =>
        ++attempt === 1
          ? json({ error: "conflict", reason: "user_exists", message: "x" }, 409)
          : json([...USERS, { id: "u-sofia", ...body, createdAt: "2026-10-19T12:00:00.000Z" }], 201),
    });
    renderAt("/plataforma/usuarios");
    expect(await screen.findByText("Tú")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Sofía" } });
    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "sofia@hablahora.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invitar administrador" }));
    expect(await screen.findByText("Ya hay una cuenta con ese correo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invitar administrador" }));
    expect(await screen.findByText("Invitación enviada a sofia@hablahora.test.")).toBeTruthy();
  });

  it("en inglés", async () => {
    api({}, { ...ME_PLATFORM, user: { ...ME_PLATFORM.user, locale: "en" } });
    renderAt("/plataforma/negocios");
    expect(await screen.findByRole("heading", { name: "Businesses" })).toBeTruthy();
    expect(await screen.findByText("42 of 1500 conversations")).toBeTruthy();
  });
});

describe("estado del negocio en su consola", () => {
  const merchant = (status: string) =>
    mockApi({
      "GET /api/me": () => ({ ...ME_ADMIN, business: { ...ME_ADMIN.business, status } }),
      "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
      "GET /api/merchant/business": () => ({ timezone: "America/New_York" }),
      "GET /api/merchant/handoff/count": () => ({ count: 0 }),
      "GET /api/merchant/bookings": () => ({ items: [] }),
      "GET /api/auth/organization/list": () => [],
    });

  it("suspendido: aviso de solo lectura", async () => {
    merchant("suspended");
    renderAt("/");
    expect(await screen.findByText(/Tu negocio está suspendido/)).toBeTruthy();
    expect(screen.getByText(/Hola, Valeria/)).toBeTruthy();
  });

  it("dado de baja: no se muestra la consola", async () => {
    merchant("closed");
    renderAt("/");
    expect(await screen.findByText("Este negocio fue dado de baja")).toBeTruthy();
    expect(screen.queryByText(/Hola, Valeria/)).toBeNull();
  });
});
