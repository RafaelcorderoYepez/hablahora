// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME_ADMIN, ME_STAFF, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

// ---------- datos de ejemplo (Salón Aurora) ----------

const BUSINESS = {
  name: "Salón Aurora",
  locationName: "Brickell",
  address: "1250 Brickell Ave",
  timezone: "America/New_York",
  country: "US",
  currency: "USD",
  defaultLocale: "es",
  agentTone: "warm",
  agentInstructions: "Estacionamiento en el edificio.",
  agentInstructionsEn: null,
  agentHandoff: null,
  agentHandoffEn: null,
  webChatSlug: "salon-aurora",
  chatEnabled: true,
  chatSettings: { palette: "rosa", accent: null, appearance: "auto", welcome: { es: null, en: null } },
};
const STAFF = [
  { id: "s-valeria", name: "Valeria", active: true, serviceIds: ["svc-corte"], schedule: null },
  {
    id: "s-diego",
    name: "Diego",
    active: true,
    serviceIds: ["svc-hombre"],
    schedule: [4, 5, 6].map((weekday) => ({ weekday, start: "12:00", end: "19:00" })),
  },
];
const SERVICES = [
  {
    id: "svc-corte",
    name: "Corte de mujer",
    description: "Con lavado.",
    nameEn: "Women's haircut",
    descriptionEn: null,
    durationMin: 60,
    bufferAfterMin: 0,
    price: 5500,
    active: true,
    staffIds: ["s-valeria"],
  },
  {
    id: "svc-hombre",
    name: "Corte de hombre",
    description: null,
    nameEn: null,
    descriptionEn: null,
    durationMin: 30,
    bufferAfterMin: 0,
    price: 3000,
    active: true,
    staffIds: [],
  },
];
const HOURS = { schedule: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "19:00" })) };
const POLICIES = { slotIntervalMin: 15, minLeadTimeMin: 60, maxAdvanceDays: 60, cancelCutoffMin: 240, autoConfirm: true };
const READY = {
  ready: true,
  checks: ["services", "hours", "web_chat_slug"].map((key) => ({ key, ok: true, required: true })),
};

function api(extra: Record<string, Handler> = {}, me: object = ME_ADMIN) {
  mockApi({
    "GET /api/me": () => me,
    "GET /api/merchant/readiness": () => READY,
    "GET /api/merchant/business": () => BUSINESS,
    "GET /api/merchant/services": () => SERVICES,
    "GET /api/merchant/staff": () => STAFF,
    "GET /api/merchant/hours": () => HOURS,
    "GET /api/merchant/closures": () => [],
    "GET /api/merchant/policies": () => POLICIES,
    "GET /api/merchant/web-chat": () => ({
      slug: "salon-aurora",
      enabled: true,
      publicUrl: "http://localhost:5173/salon-aurora",
      embedScriptUrl: "http://localhost:5173/embed.js",
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

describe("negocio", () => {
  it("valida la zona horaria y guarda", async () => {
    api({ "PATCH /api/merchant/business": (b) => ({ ...BUSINESS, ...b }) });
    renderAt("/negocio");
    const name = (await screen.findByLabelText("Nombre del negocio")) as HTMLInputElement;
    expect(name.value).toBe("Salón Aurora");

    fireEvent.change(screen.getByLabelText("Zona horaria"), { target: { value: "Marte/Olympus" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText(/Elige una zona de la lista/)).toBeTruthy();
    expect(sent("PATCH", "/api/merchant/business")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Zona horaria"), { target: { value: "America/Chicago" } });
    fireEvent.change(name, { target: { value: "Aurora Studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Guardado.")).toBeTruthy();
    expect(sent("PATCH", "/api/merchant/business")[0].body).toEqual({
      name: "Aurora Studio",
      locationName: "Brickell",
      address: "1250 Brickell Ave",
      timezone: "America/Chicago",
      defaultLocale: "es",
    });
  });

  it("el staff ve todo desactivado y sin botón de guardar", async () => {
    api({}, ME_STAFF);
    renderAt("/negocio");
    // desactivado por el fieldset: la propiedad disabled no lo refleja, :disabled sí
    expect((await screen.findByLabelText("Nombre del negocio")).matches(":disabled")).toBe(true);
    expect(screen.getByText("Tu rol es staff: puedes ver la configuración, pero no cambiarla.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
  });
});

describe("servicios", () => {
  it("lista con avisos y crea un servicio con su versión en inglés", async () => {
    api({ "POST /api/merchant/services": (b) => ({ id: "svc-nuevo", ...b }) });
    renderAt("/servicios");
    const hombre = (await screen.findByText("Corte de hombre")).closest("li")!;
    expect(within(hombre).getAllByText(/Sin profesionales activos/).length).toBeGreaterThan(0);
    const corte = screen.getByText("Corte de mujer").closest("li")!;
    expect(within(corte).getByText(/60 min · \$55\.00 · Valeria/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Nuevo servicio" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await within(dialog).findByText("Escribe el nombre del servicio.")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "Alisado" } });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Inglés" }));
    fireEvent.change(within(dialog).getByLabelText("Nombre en inglés"), { target: { value: "Keratin smoothing" } });
    fireEvent.change(within(dialog).getByLabelText("Duración (minutos)"), { target: { value: "90" } });
    fireEvent.change(within(dialog).getByLabelText(/Precio/), { target: { value: "25,50" } });
    fireEvent.click(within(dialog).getByLabelText("Valeria"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Servicio creado.")).toBeTruthy();
    expect(sent("POST", "/api/merchant/services")[0].body).toEqual({
      name: "Alisado",
      description: null,
      nameEn: "Keratin smoothing",
      descriptionEn: null,
      durationMin: 90,
      bufferAfterMin: 0,
      price: 2550,
      staffIds: ["s-valeria"],
      active: true,
    });
  });

  it("negocio de Chile: precios en pesos, sin decimales y con punto de miles", async () => {
    api({
      "GET /api/merchant/business": () => ({ ...BUSINESS, country: "CL", currency: "CLP" }),
      "GET /api/merchant/services": () => SERVICES.map((s) => (s.id === "svc-corte" ? { ...s, price: 18000 } : s)),
      "PATCH /api/merchant/services/svc-corte": (b) => ({ ...SERVICES.find((s) => s.id === "svc-corte"), ...b }),
    });
    renderAt("/servicios");
    const corte = (await screen.findByText("Corte de mujer")).closest("li")!;
    expect(await within(corte).findByText(/60 min · \$18\.000 · Valeria/)).toBeTruthy();

    fireEvent.click(within(corte).getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    const price = within(dialog).getByLabelText("Precio (CLP)") as HTMLInputElement;
    expect(price.value).toBe("18.000");
    fireEvent.change(price, { target: { value: "19,5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await within(dialog).findByText("Escribe un precio válido, por ejemplo 18.000.")).toBeTruthy();
    fireEvent.change(price, { target: { value: "19.500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(sent("PATCH", "/api/merchant/services/svc-corte")).toHaveLength(1));
    expect(sent("PATCH", "/api/merchant/services/svc-corte")[0].body).toMatchObject({ price: 19500 });
  });

  it("un error de la API se explica en el idioma de la consola", async () => {
    api({
      "PATCH /api/merchant/services/svc-corte": () =>
        json({ error: "unprocessable", reason: "service_needs_staff", message: "Un servicio activo necesita…" }, 422),
    });
    renderAt("/servicios");
    const corte = (await screen.findByText("Corte de mujer")).closest("li")!;
    fireEvent.click(within(corte).getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Valeria")); // la quita
    expect(within(dialog).getByText("Sin profesionales activos, este servicio no se puede reservar.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Un servicio disponible necesita al menos un profesional activo.")).toBeTruthy();
  });
});

describe("equipo", () => {
  it("muestra el horario resumido y, al desactivar, avisa lo que quedó", async () => {
    api({
      "PATCH /api/merchant/staff/s-diego": (b) => ({ ...STAFF[1], ...b, futureBookings: 2, servicesWithoutStaff: ["Corte de hombre"] }),
      "PUT /api/merchant/staff/s-diego/schedule": (b) => ({ ...STAFF[1], schedule: b.schedule }),
    });
    renderAt("/equipo");
    const diego = (await screen.findByText("Diego")).closest("li")!;
    expect(within(diego).getByText("jue–sáb 12:00–19:00")).toBeTruthy();
    expect(within(screen.getByText("Valeria").closest("li")!).getByText("El horario del local")).toBeTruthy();

    fireEvent.click(within(diego).getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("switch", { name: "Activo (recibe reservas)" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Tiene horario propio" })); // vuelve al del local
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Tiene 2 reservas futuras: siguen en pie.")).toBeTruthy();
    expect(screen.getByText("Estos servicios quedaron sin nadie que los haga: Corte de hombre.")).toBeTruthy();
    expect(sent("PATCH", "/api/merchant/staff/s-diego")[0].body).toEqual({ name: "Diego", active: false, serviceIds: ["svc-hombre"] });
    expect(sent("PUT", "/api/merchant/staff/s-diego/schedule")[0].body).toEqual({ schedule: null });
  });
});

describe("horario", () => {
  it("abre un día, avisa si los tramos se pisan y guarda el horario entero", async () => {
    api({ "PUT /api/merchant/hours": (b) => b });
    renderAt("/horario");
    const sunday = (await screen.findByLabelText("Domingo")) as HTMLInputElement;
    expect(sunday.checked).toBe(false);
    fireEvent.click(sunday);
    fireEvent.change(screen.getByLabelText("Domingo Abre"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Domingo Cierra"), { target: { value: "14:00" } });

    // un segundo tramo que se pisa con el primero
    const sundayRow = sunday.closest("div")!.parentElement!;
    fireEvent.click(within(sundayRow).getByRole("button", { name: "Agregar tramo" }));
    fireEvent.change(screen.getByLabelText("Domingo Abre", { selector: "#business-hours-0-1-start" }), { target: { value: "13:00" } });
    expect(await screen.findByText("Los tramos de este día se pisan.")).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Guardar" })[0] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(sundayRow).getAllByRole("button", { name: /Quitar tramo/ })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Guardar" })[0]);
    await waitFor(() => expect(sent("PUT", "/api/merchant/hours")).toHaveLength(1));
    expect(sent("PUT", "/api/merchant/hours")[0].body.schedule).toContainEqual({ weekday: 0, start: "10:00", end: "14:00" });
    expect(sent("PUT", "/api/merchant/hours")[0].body.schedule).toHaveLength(6);
  });
});

describe("políticas", () => {
  it("al apagar la confirmación automática avisa, y guarda", async () => {
    api({ "PUT /api/merchant/policies": (b) => b });
    renderAt("/politicas");
    const toggle = await screen.findByRole("switch", { name: "Confirmar las reservas automáticamente" });
    fireEvent.click(toggle);
    expect(screen.getByText(/Las reservas quedarán pendientes hasta que las confirmes/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cada cuánto se ofrecen horarios"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(sent("PUT", "/api/merchant/policies")).toHaveLength(1));
    expect(sent("PUT", "/api/merchant/policies")[0].body).toEqual({ ...POLICIES, slotIntervalMin: 30, autoConfirm: false });
  });
});

describe("agente", () => {
  it("elige el tono y escribe en los dos idiomas", async () => {
    api({ "PATCH /api/merchant/business": (b) => ({ ...BUSINESS, ...b }) });
    renderAt("/agente");
    fireEvent.click(await screen.findByRole("radio", { name: "Breve" }));
    const handoffTabs = screen.getAllByRole("tab", { name: "Inglés" });
    fireEvent.click(handoffTabs[1]);
    fireEvent.change(screen.getByLabelText("Cuándo pasar con una persona (Inglés)"), { target: { value: "- Bridal quotes." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(sent("PATCH", "/api/merchant/business")).toHaveLength(1));
    expect(sent("PATCH", "/api/merchant/business")[0].body).toEqual({
      agentTone: "brief",
      agentInstructions: "Estacionamiento en el edificio.",
      agentInstructionsEn: "",
      agentHandoff: "",
      agentHandoffEn: "- Bridal quotes.",
    });
  });
});

describe("chat web", () => {
  it("no deja encender el chat si falta lo mínimo, y dice qué falta", async () => {
    api({
      "GET /api/merchant/business": () => ({ ...BUSINESS, chatEnabled: false }),
      "GET /api/merchant/readiness": () => ({
        ready: false,
        checks: [
          { key: "services", ok: false, required: true },
          { key: "hours", ok: true, required: true },
          { key: "web_chat_slug", ok: true, required: true },
        ],
      }),
    });
    renderAt("/chat-web");
    const toggle = (await screen.findByRole("switch", { name: "Chat activo" })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(screen.getByText("Para activarlo falta:")).toBeTruthy();
    expect(screen.getAllByText("Al menos un servicio activo con un profesional").length).toBeGreaterThan(0);
  });

  it("apaga el chat, muestra el enlace y el código para incrustar", async () => {
    api({ "PATCH /api/merchant/business": (b) => ({ ...BUSINESS, ...b }) });
    renderAt("/chat-web");
    expect(await screen.findByText("http://localhost:5173/salon-aurora")).toBeTruthy();
    expect(
      screen.getByText('<script src="http://localhost:5173/embed.js" data-slug="salon-aurora" async></script>'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Chat activo" }));
    expect(await screen.findByText("Chat apagado.")).toBeTruthy();
    expect(sent("PATCH", "/api/merchant/business")[0].body).toEqual({ chatEnabled: false });
  });

  it("un color propio muy claro no se puede guardar; uno oscuro sí", async () => {
    api({ "PATCH /api/merchant/business": (b) => ({ ...BUSINESS, ...b }) });
    renderAt("/chat-web");
    fireEvent.click(await screen.findByLabelText("Color propio"));
    const input = screen.getByLabelText("Color propio", { selector: "input#chat-custom" });
    fireEvent.change(input, { target: { value: "#F5E0A0" } });
    expect(await screen.findByText(/Ese color es muy claro/)).toBeTruthy();
    const save = screen.getAllByRole("button", { name: "Guardar" }).at(-1) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "#1F5F7A" } });
    fireEvent.click(save);
    await waitFor(() => expect(sent("PATCH", "/api/merchant/business")).toHaveLength(1));
    expect(sent("PATCH", "/api/merchant/business")[0].body).toEqual({
      chatSettings: { palette: "custom", accent: "#1F5F7A", appearance: "auto", welcome: { es: null, en: null } },
    });
  });

  it("un enlace ocupado se explica junto al campo", async () => {
    api({
      "PATCH /api/merchant/business": () =>
        json({ error: "conflict", reason: "slug_taken", message: "Ese enlace del chat ya lo usa otro negocio" }, 409),
    });
    renderAt("/chat-web");
    fireEvent.change(await screen.findByLabelText("Dirección del enlace"), { target: { value: "barberia-norte" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Guardar" })[0]);
    expect((await screen.findAllByText("Ese enlace ya lo usa otro negocio. Elige otro.")).length).toBeGreaterThan(0);
  });
});
