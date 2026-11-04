// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME_ADMIN, ME_STAFF, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

// ---------- datos de ejemplo (Salón Aurora, miércoles 14 de octubre) ----------

const DATE = "2026-10-14";
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
const VALERIA = "00000000-0000-4000-8000-000000000101";
const CAMILA = "00000000-0000-4000-8000-000000000102";
const STAFF = [
  { id: VALERIA, name: "Valeria", active: true, serviceIds: ["svc-corte"], schedule: null },
  { id: CAMILA, name: "Camila", active: true, serviceIds: ["svc-corte"], schedule: null },
];
const SERVICES = [
  {
    id: "svc-corte",
    name: "Corte de mujer",
    description: null,
    nameEn: null,
    descriptionEn: null,
    durationMin: 60,
    bufferAfterMin: 0,
    price: 5500,
    active: true,
    staffIds: [VALERIA, CAMILA],
  },
];

function booking(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    date: DATE,
    time: "10:00",
    endTime: "11:00",
    startMin: 600,
    endMin: 660,
    status: "confirmed",
    source: "web",
    service: { id: "svc-corte", name: "Corte de mujer" },
    staff: { id: VALERIA, name: "Valeria" },
    customer: { id: "c1", name: "Rosa Díaz", phone: "+13055550001", email: "rosa@example.com" },
    conversationId: null,
    notes: null,
    createdAt: "2026-10-12T16:00:00.000Z",
    ...over,
  };
}

const AGENDA = {
  date: DATE,
  timezone: "America/New_York",
  country: "US",
  currency: "USD",
  open: [{ start: 540, end: 1140 }],
  staff: [
    { id: VALERIA, name: "Valeria", windows: [{ start: 540, end: 1140 }] },
    { id: CAMILA, name: "Camila", windows: [{ start: 540, end: 900 }] },
  ],
  bookings: [
    booking(),
    booking({ id: "b2", time: "11:00", endTime: "11:45", startMin: 660, endMin: 705, status: "pending", staff: { id: CAMILA, name: "Camila" }, customer: { id: "c2", name: "Marta Gómez", phone: null, email: null } }),
  ],
};

function api(extra: Record<string, Handler> = {}, me: object = ME_ADMIN) {
  mockApi({
    "GET /api/me": () => me,
    "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
    "GET /api/merchant/business": () => BUSINESS,
    "GET /api/merchant/services": () => SERVICES,
    "GET /api/merchant/staff": () => STAFF,
    "GET /api/merchant/agenda": () => AGENDA,
    "GET /api/merchant/bookings": () => ({ items: AGENDA.bookings }),
    "GET /api/merchant/availability": () => ({ times: [{ time: "15:00", staffIds: [VALERIA] }, { time: "15:15", staffIds: [VALERIA] }] }),
    "GET /api/auth/organization/list": () => [],
    ...extra,
  });
}

beforeEach(setupBrowser);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openBooking = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  return screen.findByRole("dialog");
};

describe("agenda", () => {
  it("una columna por profesional con sus reservas y el día en el idioma de la consola", async () => {
    api();
    renderAt(`/agenda?date=${DATE}`);
    expect(await screen.findByRole("heading", { name: /miércoles, 14 de octubre/i })).toBeTruthy();
    const rosa = await screen.findByRole("button", { name: /Rosa Díaz/ });
    expect(rosa.textContent).toContain("10:00–11:00");
    const marta = screen.getByRole("button", { name: /Marta Gómez/ });
    expect(marta.textContent).toContain("Por confirmar");
    expect(screen.getAllByText("Valeria").length).toBeGreaterThan(0);
    expect(sent("GET", "/api/merchant/agenda")).toHaveLength(1);

    // día siguiente
    fireEvent.click(screen.getByRole("button", { name: "Día siguiente" }));
    await waitFor(() => expect(sent("GET", "/api/merchant/agenda")).toHaveLength(2));
  });

  it("confirmar una pendiente: el panel muestra el estado nuevo", async () => {
    api({ "POST /api/merchant/bookings/b2/confirm": () => booking({ id: "b2", status: "confirmed", customer: { id: "c2", name: "Marta Gómez", phone: null, email: null } }) });
    renderAt(`/agenda?date=${DATE}`);
    const dialog = await openBooking("Marta Gómez");
    expect(within(dialog).getByText("Sin datos de contacto")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText("Reserva confirmada.")).toBeTruthy();
    expect(await within(dialog).findByText("Confirmada")).toBeTruthy();
    expect(sent("POST", "/api/merchant/bookings/b2/confirm")).toHaveLength(1);
  });

  it("cancelar con motivo", async () => {
    api({ "POST /api/merchant/bookings/b1/cancel": () => booking({ status: "cancelled" }) });
    renderAt(`/agenda?date=${DATE}`);
    const dialog = await openBooking("Rosa Díaz");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar reserva" }));
    fireEvent.change(within(dialog).getByLabelText("Motivo (opcional)"), { target: { value: "Se enfermó Valeria" } });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Cancelar reserva" }).at(-1)!);
    expect(await screen.findByText("Reserva cancelada.")).toBeTruthy();
    expect(sent("POST", "/api/merchant/bookings/b1/cancel")[0].body).toEqual({ reason: "Se enfermó Valeria" });
  });

  it("mover a una hora libre (su propio horario cuenta como libre)", async () => {
    api({ "POST /api/merchant/bookings/b1/reschedule": () => booking({ id: "b3", time: "15:00" }) });
    renderAt(`/agenda?date=${DATE}`);
    const dialog = await openBooking("Rosa Díaz");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mover" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "15:00" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Mover" }));
    expect(await screen.findByText("Reserva movida.")).toBeTruthy();
    expect(sent("POST", "/api/merchant/bookings/b1/reschedule")[0].body).toEqual({
      date: DATE,
      time: "15:00",
      staffId: VALERIA,
      outsideHours: false,
    });
    const asked = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => String(u));
    expect(asked.some((u) => u.includes("/api/merchant/availability") && u.includes("bookingId=b1"))).toBe(true);
  });

  it("el staff también crea reservas: busca al cliente, elige hora; un error se explica", async () => {
    let attempt = 0;
    api(
      {
        "GET /api/merchant/customers": (_b, url) =>
          url.searchParams.get("q") === "ro" ? { items: [{ id: "c1", name: "Rosa Díaz", phone: "+13055550001", email: null }] } : { items: [] },
        "POST /api/merchant/bookings": () =>
          ++attempt === 1
            ? json({ error: "conflict", reason: "slot_taken", message: "x" }, 409)
            : json(booking({ id: "b9", time: "15:15", source: "staff" }), 201),
      },
      ME_STAFF,
    );
    renderAt(`/agenda?date=${DATE}`);
    fireEvent.click(await screen.findByRole("button", { name: "Nueva reserva" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Buscar cliente"), { target: { value: "ro" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Rosa Díaz/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "15:00" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar reserva" }));
    expect(await screen.findByText("Ese horario se acaba de ocupar. Elige otro.")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "15:15" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar reserva" }));
    expect(await screen.findByText("Reserva creada.")).toBeTruthy();
    expect(sent("POST", "/api/merchant/bookings")[1].body).toEqual({
      serviceId: "svc-corte",
      date: DATE,
      time: "15:15",
      staffId: null,
      outsideHours: false,
      notes: null,
      customer: { id: "c1" },
    });
  });

  it("cliente nuevo fuera de horario: pide nombre y contacto", async () => {
    api({ "POST /api/merchant/bookings": () => json(booking({ id: "b9", time: "19:30" }), 201) });
    renderAt(`/agenda?date=${DATE}`);
    fireEvent.click(await screen.findByRole("button", { name: "Nueva reserva" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: "Valeria" });
    fireEvent.change(within(dialog).getByLabelText("Profesional"), { target: { value: VALERIA } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Fuera de horario/ }));
    fireEvent.change(within(dialog).getByLabelText("Hora"), { target: { value: "19:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cliente nuevo" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar reserva" }));
    expect(await within(dialog).findByText("Escribe el nombre.")).toBeTruthy();
    expect(within(dialog).getByText("Indica teléfono o email.")).toBeTruthy();
    expect(sent("POST", "/api/merchant/bookings")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "Lucía" } });
    fireEvent.change(within(dialog).getByLabelText("Teléfono"), { target: { value: "305 555 0199" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar reserva" }));
    await waitFor(() => expect(sent("POST", "/api/merchant/bookings")).toHaveLength(1));
    expect(sent("POST", "/api/merchant/bookings")[0].body).toMatchObject({
      time: "19:30",
      staffId: VALERIA,
      outsideHours: true,
      customer: { name: "Lucía", phone: "305 555 0199", email: null },
    });
  });

  it("en inglés", async () => {
    api({}, { ...ME_ADMIN, user: { ...ME_ADMIN.user, locale: "en" } });
    renderAt(`/agenda?date=${DATE}`);
    expect(await screen.findByRole("heading", { name: /Wednesday, October 14/ })).toBeTruthy();
    expect((await screen.findByRole("button", { name: /Marta Gómez/ })).textContent).toContain("To confirm");
    expect(screen.getByRole("button", { name: "New booking" })).toBeTruthy();
  });
});

describe("mover arrastrando", () => {
  /** Columnas de 600 px (de 9:00 a 19:00, 1 px por minuto); el puntero está sobre la columna `over`. */
  function geometry(over: () => string) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0, left: 0, bottom: 600, right: 200, width: 200, height: 600, x: 0, y: 0, toJSON() {},
    } as DOMRect);
    document.elementsFromPoint = () => [document.querySelector(`[data-drop-staff="${over()}"]`)!];
  }

  it("a otro profesional y hora: confirma y mueve", async () => {
    api({ "POST /api/merchant/bookings/b1/reschedule": () => booking({ id: "b3", time: "12:00", staff: { id: CAMILA, name: "Camila" } }) });
    let over = VALERIA;
    geometry(() => over);
    renderAt(`/agenda?date=${DATE}`);
    const rosa = await screen.findByRole("button", { name: /Rosa Díaz/ });

    fireEvent.pointerDown(rosa, { button: 0, pointerType: "mouse", clientX: 50, clientY: 70 }); // 10:10, 10 min dentro de la reserva
    over = CAMILA;
    fireEvent.pointerMove(window, { clientX: 250, clientY: 190 }); // 12:10 → empieza a las 12:00 (Marta termina 11:45)
    expect(await screen.findByText("12:00–13:00")).toBeTruthy(); // la silueta
    fireEvent.pointerUp(window, { clientX: 250, clientY: 190 });

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("¿Mover a Camila, 12:00?")).toBeTruthy();
    expect(within(dialog).queryByText(/fuera del horario/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Mover" }));
    expect(await screen.findByText("Reserva movida.")).toBeTruthy();
    expect(sent("POST", "/api/merchant/bookings/b1/reschedule")[0].body).toEqual({
      date: DATE,
      time: "12:00",
      staffId: CAMILA,
      outsideHours: false,
    });
    expect(screen.queryByRole("dialog")).toBeNull(); // soltar no abre el panel
  });

  it("fuera del horario lo avisa; cancelar no cambia nada", async () => {
    api();
    geometry(() => CAMILA);
    renderAt(`/agenda?date=${DATE}`);
    const rosa = await screen.findByRole("button", { name: /Rosa Díaz/ });
    fireEvent.pointerDown(rosa, { button: 0, pointerType: "mouse", clientX: 50, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 420 }); // 16:00, Camila sale a las 15:00
    fireEvent.pointerUp(window, { clientX: 250, clientY: 420 });
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Queda fuera del horario de Camila/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Volver" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent("POST", "/api/merchant/bookings/b1/reschedule")).toHaveLength(0);
  });

  it("encima de otra reserva: la silueta dice Ocupado y al soltar no pide confirmar", async () => {
    api();
    geometry(() => CAMILA);
    renderAt(`/agenda?date=${DATE}`);
    const rosa = await screen.findByRole("button", { name: /Rosa Díaz/ });
    fireEvent.pointerDown(rosa, { button: 0, pointerType: "mouse", clientX: 50, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 140 }); // 11:20 → 11:15, encima de Marta (11:00–11:45)
    expect(await screen.findByText("Ocupado")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 250, clientY: 140 });
    expect(await screen.findByText("Ese horario ya está ocupado. Suelta la reserva en un hueco libre.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent("POST", "/api/merchant/bookings/b1/reschedule")).toHaveLength(0);
  });

  it("con el dedo no se arrastra (queda el botón Mover)", async () => {
    api();
    geometry(() => CAMILA);
    renderAt(`/agenda?date=${DATE}`);
    const rosa = await screen.findByRole("button", { name: /Rosa Díaz/ });
    fireEvent.pointerDown(rosa, { button: 0, pointerType: "touch", clientX: 50, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 300 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("listado de reservas", () => {
  it("filtra por estado y busca por cliente; el detalle se abre en el panel", async () => {
    api();
    renderAt(`/reservas?from=${DATE}&to=2026-10-31`);
    expect(await screen.findByText("2 reservas")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "pending" } });
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "marta" } });
    await waitFor(() => {
      const asked = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => String(u));
      expect(asked.some((u) => u.includes("/api/merchant/bookings?") && u.includes("status=pending") && u.includes("q=marta"))).toBe(true);
    });
    const dialog = await openBooking("Rosa Díaz");
    expect(within(dialog).getByText("rosa@example.com")).toBeTruthy();
  });

  it("un rango de más de 62 días no se consulta", async () => {
    api();
    renderAt(`/reservas?from=${DATE}&to=2027-01-31`);
    expect(await screen.findByText("Elige un rango de hasta 62 días.")).toBeTruthy();
    expect(sent("GET", "/api/merchant/bookings")).toHaveLength(0);
  });

  it("el inicio avisa de las reservas por confirmar", async () => {
    api({ "GET /api/merchant/bookings": (_b, url) => ({ items: url.searchParams.get("status") === "pending" ? [AGENDA.bookings[1]] : [] }) });
    renderAt("/");
    expect(await screen.findByText("Tienes 1 reserva por confirmar.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Revisar" }).getAttribute("href")).toContain("status=pending");
  });
});
