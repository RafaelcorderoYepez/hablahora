import {
  Business,
  BookingList,
  Closure,
  ConversationDetail,
  ConversationPage,
  Policies,
  Service,
  Staff,
  StaffPatchResult,
} from "@hablahora/contracts";
import {
  AgentRunner,
  BookingService,
  handleBookingTool,
  WebChatProcessor,
  type ConversationContext,
} from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { MemoryEmailSender } from "@hablahora/core";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { call, FAKE_MODEL, FakeLlm, findInHistory, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

const TZ = AURORA.timezone;
const WED = "2026-10-14";
const THU = "2026-10-15";

/** Segundo negocio, para probar que ninguno ve ni toca lo del otro. */
const NORTE = {
  tenant: "b0b0b0b0-0000-4000-8000-000000000001",
  location: "b0b0b0b0-0000-4000-8000-000000000002",
  staff: "b0b0b0b0-0000-4000-8000-000000000101",
  service: "b0b0b0b0-0000-4000-8000-000000000201",
  slug: "barberia-norte",
  owner: { email: "duena@barberia-norte.test", name: "Marta" },
};

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let now: Date;
let bookings: BookingService;
let server: ReturnType<typeof buildServer>;
const llm = new FakeLlm();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: ORIGIN,
    email: new MemoryEmailSender(),
  });
  auth = created.auth;
  authDb = created.pool;
  const clock = () => now;
  bookings = new BookingService(app, clock);
  const runner = new AgentRunner({ db: app, bookings, clock, model: FAKE_MODEL, llm: llm.client });
  const quiet = { info() {}, warn() {}, error() {} };
  server = buildServer({
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], chatPublicURL: "http://chat.test/", clock },
    webChat: new WebChatProcessor({ db: app, runner, clock, log: quiet }),
  });
});

afterAll(async () => {
  await server.app.close();
  await authDb.end();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await seedSalonAurora(admin);
  await seedAuroraUsers({ auth, authDb, adminDb: admin, tenantId: AURORA.tenant, slug: AURORA.slug });
  await seedNorte();
  now = DateTime.fromISO("2026-10-12T12:00", { zone: TZ }).toJSDate();
  llm.reset();
});

afterEach(() => {
  expect(llm.stepErrors).toEqual([]);
});

async function seedNorte() {
  for (const t of [
    "booking_policies",
    "availability_rules",
    "service_resources",
    "services",
    "resources",
    "locations",
  ]) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [NORTE.tenant]);
  }
  await admin.query("DELETE FROM tenants WHERE id = $1", [NORTE.tenant]);
  await authDb.query(`DELETE FROM organization WHERE slug = $1`, [NORTE.slug]);
  await authDb.query(`DELETE FROM "user" WHERE email = $1`, [NORTE.owner.email]);

  await admin.query(`INSERT INTO tenants (id, name, vertical) VALUES ($1, 'Barbería Norte', 'salon')`, [NORTE.tenant]);
  await admin.query(
    `INSERT INTO locations (id, tenant_id, name, timezone, web_chat_slug) VALUES ($1, $2, 'Norte', 'America/Chicago', $3)`,
    [NORTE.location, NORTE.tenant, NORTE.slug],
  );
  await admin.query(`INSERT INTO resources (id, tenant_id, location_id, kind, name) VALUES ($1, $2, $3, 'staff', 'Tomás')`, [
    NORTE.staff,
    NORTE.tenant,
    NORTE.location,
  ]);
  await admin.query(
    `INSERT INTO services (id, tenant_id, location_id, name, resource_kind, duration_min) VALUES ($1, $2, $3, 'Barba', 'staff', 30)`,
    [NORTE.service, NORTE.tenant, NORTE.location],
  );
  await admin.query(`INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, $3)`, [
    NORTE.service,
    NORTE.staff,
    NORTE.tenant,
  ]);
  const { user } = await auth.api.createUser({ body: { ...NORTE.owner, password: DEV_PASSWORD } });
  const org = await auth.api.createOrganization({ body: { name: "Barbería Norte", slug: NORTE.slug, userId: user.id } });
  await admin.query("UPDATE tenants SET auth_organization_id = $2 WHERE id = $1", [NORTE.tenant, org!.id]);
}

const as = async (email: string) => {
  const b = browser(server.app);
  expect((await b.signIn(email, DEV_PASSWORD)).statusCode).toBe(200);
  return b;
};
const valeria = () => as(AURORA_USERS.valeria.email);

/** PATCH/PUT/DELETE con cookie y origen, como la consola. */
async function send(b: ReturnType<typeof browser>, method: "PATCH" | "PUT" | "DELETE" | "POST", url: string, payload?: unknown, origin = ORIGIN) {
  return server.app.inject({
    method,
    url,
    headers: { cookie: b.cookie, ...(origin ? { origin } : {}) },
    ...(payload !== undefined ? { payload: payload as any } : {}),
  });
}

const ctx = (): ConversationContext => ({ tenantId: AURORA.tenant, locationId: AURORA.location, channel: "web" });
const times = async (serviceId: string, date: string) =>
  (await bookings.checkAvailability(ctx(), { serviceId, date, partySize: 1, maxResults: 200 })).slots.map((s) => s.time);

/** Reserva confirmada directa con el motor (como si viniera del chat de WhatsApp). */
async function book(serviceId: string, date: string, time: string, phone = "+13055550001") {
  const c: ConversationContext = { ...ctx(), channel: "whatsapp", verifiedPhone: phone };
  const h = await bookings.holdSlot(c, { serviceId, date, time, partySize: 1, customerName: "Cliente" });
  if (!h.ok) throw new Error(`no se pudo apartar: ${h.reason}`);
  await bookings.confirmBooking(c, h.booking.id);
  return h.booking.id;
}

// ---------------------------------------------------------------------

describe("permisos", () => {
  it("sin sesión 401; staff lee pero no escribe; plataforma sin membresía 403", async () => {
    expect((await server.app.inject({ url: "/api/merchant/business" })).statusCode).toBe(401);

    const camila = await as(AURORA_USERS.camila.email);
    expect((await camila.get("/api/merchant/business")).statusCode).toBe(200);
    const write = await send(camila, "PATCH", "/api/merchant/business", { address: "Otra" });
    expect(write.statusCode).toBe(403);

    const platform = await as(AURORA_USERS.platformAdmin.email);
    expect((await platform.get("/api/merchant/business")).statusCode).toBe(403);
  });

  it("las escrituras solo se aceptan desde el origen de la consola", async () => {
    const v = await valeria();
    expect((await send(v, "PATCH", "/api/merchant/business", { address: "X" }, "https://malicioso.example")).statusCode).toBe(403);
    expect((await send(v, "PATCH", "/api/merchant/business", { address: "X" }, "")).statusCode).toBe(403);
    expect((await send(v, "PATCH", "/api/merchant/business", { address: "X" })).statusCode).toBe(200);
  });
});

describe("negocio", () => {
  it("lee y modifica los datos del negocio; el nombre se sincroniza con la organización", async () => {
    const v = await valeria();
    const before = Business.parse((await v.get("/api/merchant/business")).json());
    expect(before).toMatchObject({ name: "Salón Aurora", timezone: TZ, defaultLocale: "es", webChatSlug: AURORA.slug });

    const res = await send(v, "PATCH", "/api/merchant/business", {
      name: "Aurora Studio",
      address: "200 Brickell Ave",
      defaultLocale: "en",
      agentInstructions: "Tono cercano.",
      webChatSlug: "aurora-studio",
    });
    expect(res.statusCode).toBe(200);
    expect(Business.parse(res.json())).toMatchObject({
      name: "Aurora Studio",
      address: "200 Brickell Ave",
      defaultLocale: "en",
      agentInstructions: "Tono cercano.",
      webChatSlug: "aurora-studio",
    });
    const org = await authDb.query(`SELECT name FROM organization WHERE slug = $1`, [AURORA.slug]);
    expect(org.rows[0].name).toBe("Aurora Studio");
    // el chat se abre con el slug nuevo
    expect(
      (await server.app.inject({ method: "POST", url: "/api/chat/aurora-studio/sessions" })).statusCode,
    ).toBe(201);
  });

  it("valida: zona horaria, slug ocupado, campos desconocidos", async () => {
    const v = await valeria();
    const tz = await send(v, "PATCH", "/api/merchant/business", { timezone: "Marte/Olympus" });
    expect(tz.statusCode).toBe(400);
    expect(tz.json().issues).toEqual([expect.objectContaining({ path: "timezone" })]);

    const taken = await send(v, "PATCH", "/api/merchant/business", { webChatSlug: NORTE.slug });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: "conflict" });

    expect((await send(v, "PATCH", "/api/merchant/business", { tenantId: NORTE.tenant })).statusCode).toBe(400);
  });

  it("enlace público del chat", async () => {
    const v = await valeria();
    expect((await v.get("/api/merchant/web-chat")).json()).toEqual({
      slug: AURORA.slug,
      enabled: true,
      publicUrl: `http://chat.test/${AURORA.slug}`,
      embedScriptUrl: "http://chat.test/embed.js",
      logoUrl: null,
    });
  });
});

describe("servicios", () => {
  it("lista, crea y modifica; los cambios llegan al agente", async () => {
    const v = await valeria();
    const list = Service.array().parse((await v.get("/api/merchant/services")).json());
    expect(list.map((s) => s.name)).toEqual(["Color", "Corte de hombre", "Corte de mujer", "Manicure", "Peinado"]);
    expect(list.find((s) => s.name === "Manicure")).toMatchObject({ staffIds: [AURORA.staff.camila], price: 12000 });

    const created = await send(v, "POST", "/api/merchant/services", {
      name: "Lavado y secado",
      description: "Lavado con masaje capilar.",
      durationMin: 30,
      price: 9000,
      staffIds: [AURORA.staff.camila],
    });
    expect(created.statusCode).toBe(201);
    const svc = Service.parse(created.json());
    expect(svc).toMatchObject({ active: true, bufferAfterMin: 0 });

    // el agente lo ve, con su descripción y el precio en pesos chilenos (la moneda del negocio)
    const tool: any = await handleBookingTool(bookings, ctx(), "list_services", {});
    expect(tool.services.find((s: any) => s.name === "Lavado y secado")).toMatchObject({
      description: "Lavado con masaje capilar.",
      price: "$9.000",
      currency: "CLP",
    });

    // desactivarlo lo saca del chat
    const off = await send(v, "PATCH", `/api/merchant/services/${svc.id}`, { active: false });
    expect(off.json()).toMatchObject({ active: false });
    const after: any = await handleBookingTool(bookings, ctx(), "list_services", {});
    expect(after.services.map((s: any) => s.name)).not.toContain("Lavado y secado");
  });

  it("un servicio activo necesita un profesional activo de este negocio", async () => {
    const v = await valeria();
    const base = { name: "Alisado", durationMin: 90 };
    const none = await send(v, "POST", "/api/merchant/services", { ...base, staffIds: [] });
    expect(none.statusCode).toBe(422);
    const foreign = await send(v, "POST", "/api/merchant/services", { ...base, staffIds: [NORTE.staff] });
    expect(foreign.statusCode).toBe(422);
    // inactivo y sin profesionales sí se puede guardar (borrador)
    expect((await send(v, "POST", "/api/merchant/services", { ...base, staffIds: [], active: false })).statusCode).toBe(201);
    // datos fuera de rango
    const bad = await send(v, "POST", "/api/merchant/services", { ...base, durationMin: 2, staffIds: [AURORA.staff.valeria] });
    expect(bad.statusCode).toBe(400);
  });
});

describe("equipo", () => {
  it("lista con sus servicios y horarios propios", async () => {
    const v = await valeria();
    const staff = Staff.array().parse((await v.get("/api/merchant/staff")).json());
    const diego = staff.find((s) => s.name === "Diego")!;
    expect(diego.serviceIds).toEqual([AURORA.services.corteHombre]);
    expect(diego.schedule).toEqual([4, 5, 6].map((weekday) => ({ weekday, start: "12:00", end: "19:00" })));
  });

  it("desactivar avisa reservas futuras y servicios sin nadie, sin cancelar nada", async () => {
    await book(AURORA.services.corteHombre, THU, "13:00");
    const v = await valeria();
    const res = await send(v, "PATCH", `/api/merchant/staff/${AURORA.staff.diego}`, { active: false });
    const result = StaffPatchResult.parse(res.json());
    expect(result).toMatchObject({ active: false, futureBookings: 1, servicesWithoutStaff: ["Corte de hombre"] });

    const status = await admin.query("SELECT status FROM bookings WHERE tenant_id = $1", [AURORA.tenant]);
    expect(status.rows).toEqual([{ status: "confirmed" }]);
    expect(await times(AURORA.services.corteHombre, THU)).toEqual([]); // ya no se ofrece
  });

  it("su horario cambia lo que ofrece el chat; null vuelve al horario del local", async () => {
    const v = await valeria();
    // manicure solo la hace Camila (martes a viernes 9-15)
    expect((await times(AURORA.services.manicure, WED)).at(-1)).toBe("14:15");

    const res = await send(v, "PUT", `/api/merchant/staff/${AURORA.staff.camila}/schedule`, {
      schedule: [{ weekday: 3, start: "09:00", end: "12:00" }],
    });
    expect(Staff.parse(res.json()).schedule).toEqual([{ weekday: 3, start: "09:00", end: "12:00" }]);
    expect((await times(AURORA.services.manicure, WED)).at(-1)).toBe("11:15");
    expect(await times(AURORA.services.manicure, THU)).toEqual([]);

    await send(v, "PUT", `/api/merchant/staff/${AURORA.staff.camila}/schedule`, { schedule: null });
    expect((await times(AURORA.services.manicure, WED)).at(-1)).toBe("18:15"); // horario del local: hasta las 19

    const invalid = await send(v, "PUT", `/api/merchant/staff/${AURORA.staff.camila}/schedule`, {
      schedule: [{ weekday: 3, start: "10:00", end: "10:00" }],
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("crea un profesional y le asigna servicios", async () => {
    const v = await valeria();
    const res = await send(v, "POST", "/api/merchant/staff", { name: "Lucía", serviceIds: [AURORA.services.manicure] });
    expect(res.statusCode).toBe(201);
    const lucia = Staff.parse(res.json());
    expect(lucia).toMatchObject({ active: true, schedule: null, serviceIds: [AURORA.services.manicure] });
    // sin horario propio trabaja todo el horario del local: el miércoles hay manicure hasta las 18:15
    expect((await times(AURORA.services.manicure, WED)).at(-1)).toBe("18:15");
  });
});

describe("horario, cierres y políticas", () => {
  it("el horario del local se reemplaza entero y limita a todos", async () => {
    const v = await valeria();
    const res = await send(v, "PUT", "/api/merchant/hours", { schedule: [{ weekday: 3, start: "09:00", end: "12:00" }] });
    expect(res.json()).toEqual({ schedule: [{ weekday: 3, start: "09:00", end: "12:00" }] });
    expect((await times(AURORA.services.corteMujer, WED)).at(-1)).toBe("11:00");
    expect(await times(AURORA.services.corteMujer, THU)).toEqual([]);
  });

  it("cierres del local y de un profesional; borrarlos vuelve a abrir", async () => {
    const v = await valeria();
    const listed = Closure.array().parse((await v.get("/api/merchant/closures")).json());
    expect(listed).toEqual([expect.objectContaining({ from: "2026-11-26", to: "2026-11-26", staffId: null, reason: "Thanksgiving" })]);

    const whole = Closure.parse((await send(v, "POST", "/api/merchant/closures", { from: WED, to: WED, reason: "Fumigación" })).json());
    expect(whole).toMatchObject({ from: WED, to: WED, staffId: null });
    expect(await times(AURORA.services.corteMujer, WED)).toEqual([]);
    expect(await times(AURORA.services.corteMujer, THU)).not.toEqual([]); // solo ese día

    expect((await send(v, "DELETE", `/api/merchant/closures/${whole.id}`)).statusCode).toBe(204);
    expect(await times(AURORA.services.corteMujer, WED)).not.toEqual([]);

    // vacaciones de Valeria: el color (solo ella) no se ofrece; el corte de mujer sí (Camila)
    await send(v, "POST", "/api/merchant/closures", { from: WED, to: THU, staffId: AURORA.staff.valeria, reason: "Vacaciones" });
    expect(await times(AURORA.services.color, WED)).toEqual([]);
    expect(await times(AURORA.services.color, THU)).toEqual([]);
    expect(await times(AURORA.services.corteMujer, WED)).not.toEqual([]);

    const backwards = await send(v, "POST", "/api/merchant/closures", { from: THU, to: WED });
    expect(backwards.statusCode).toBe(400);
  });

  it("políticas: sin confirmación automática la reserva queda pendiente", async () => {
    const v = await valeria();
    expect(Policies.parse((await v.get("/api/merchant/policies")).json())).toEqual({
      slotIntervalMin: 15,
      minLeadTimeMin: 60,
      maxAdvanceDays: 60,
      cancelCutoffMin: 240,
      autoConfirm: true,
    });
    const put = await send(v, "PUT", "/api/merchant/policies", {
      slotIntervalMin: 30,
      minLeadTimeMin: 60,
      maxAdvanceDays: 30,
      cancelCutoffMin: 240,
      autoConfirm: false,
    });
    expect(put.json()).toMatchObject({ slotIntervalMin: 30, autoConfirm: false });

    expect((await times(AURORA.services.corteMujer, WED)).every((t) => t.endsWith(":00") || t.endsWith(":30"))).toBe(true);
    await book(AURORA.services.corteMujer, WED, "11:00");
    expect((await admin.query("SELECT status FROM bookings WHERE tenant_id = $1", [AURORA.tenant])).rows).toEqual([{ status: "pending" }]);

    const current = Policies.parse(put.json());
    expect((await send(v, "PUT", "/api/merchant/policies", { ...current, slotIntervalMin: 7 })).statusCode).toBe(400);
  });
});

describe("lectura", () => {
  it("reservas por rango de fechas locales y filtros", async () => {
    const wed = await book(AURORA.services.corteMujer, WED, "11:00", "+13055550001");
    await book(AURORA.services.corteHombre, THU, "13:00", "+13055550002");
    const cancelled = await book(AURORA.services.color, THU, "15:00", "+13055550003");
    await bookings.cancelBooking({ ...ctx(), channel: "whatsapp", verifiedPhone: "+13055550003" }, cancelled);

    const v = await valeria();
    const onlyWed = BookingList.parse((await v.get(`/api/merchant/bookings?from=${WED}&to=${WED}`)).json());
    expect(onlyWed.items).toEqual([
      expect.objectContaining({
        id: wed,
        date: WED,
        time: "11:00",
        endTime: "12:00",
        status: "confirmed",
        source: "whatsapp",
        service: { id: AURORA.services.corteMujer, name: "Corte de mujer" },
        staff: { id: AURORA.staff.valeria, name: "Valeria" },
        customer: { id: expect.any(String), name: "Cliente", phone: "+13055550001", email: null },
      }),
    ]);

    const both = (await v.get(`/api/merchant/bookings?from=${WED}&to=${THU}`)).json().items;
    expect(both.map((b: any) => b.status)).toEqual(["confirmed", "confirmed", "cancelled"]);
    const cancelledOnly = (await v.get(`/api/merchant/bookings?from=${WED}&to=${THU}&status=cancelled`)).json().items;
    expect(cancelledOnly).toEqual([expect.objectContaining({ id: cancelled, staff: { id: AURORA.staff.valeria, name: "Valeria" } })]);
    const diego = (await v.get(`/api/merchant/bookings?from=${WED}&to=${THU}&staffId=${AURORA.staff.diego}`)).json().items;
    expect(diego.map((b: any) => b.service.name)).toEqual(["Corte de hombre"]);

    expect((await v.get(`/api/merchant/bookings?from=2026-10-01&to=2026-12-31`)).statusCode).toBe(400);
    expect((await v.get(`/api/merchant/bookings?from=${WED}&to=${WED}&status=volando`)).statusCode).toBe(400);
  });

  it("conversaciones: lista paginada, filtro de paso a humano y detalle con traza y reservas", async () => {
    const chat = chatClient(server.app, AURORA.slug);
    const first = await chat.newSession();
    llm.script = [
      call("save_customer_contact", { name: "Rafael", phone: "912345678", email: "rafa@example.com" }),
      call("hold_slot", { service_id: AURORA.services.corteMujer, date: WED, time: "11:00", party_size: 1 }),
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
      say("Listo, Rafael: miércoles a las 11:00."),
    ];
    await chat.send(first, "Corte el miércoles a las 11, Rafael, 912345678, rafa@example.com");

    now = new Date(now.getTime() + 60_000);
    const second = await chat.newSession();
    llm.script = [call("request_human", { reason: "Pide hablar con alguien" }), say("Te comunico con el equipo.")];
    await chat.send(second, "Quiero hablar con una persona");
    await chat.newSession(); // sesión sin mensajes: no aparece

    const v = await valeria();
    const page1 = ConversationPage.parse((await v.get("/api/merchant/conversations?limit=1")).json());
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]).toMatchObject({ handoff: true, lastMessage: "Te comunico con el equipo.", bookingsCount: 0 });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = ConversationPage.parse(
      (await v.get(`/api/merchant/conversations?limit=1&cursor=${page1.nextCursor}`)).json(),
    );
    expect(page2.items[0]).toMatchObject({
      handoff: false,
      bookingsCount: 1,
      lastMessage: "Listo, Rafael: miércoles a las 11:00.",
      customer: { name: "Rafael", phone: "+56912345678", email: "rafa@example.com" },
    });
    expect(page2.nextCursor).toBeNull();

    const handoffs = (await v.get("/api/merchant/conversations?handoff=true")).json().items;
    expect(handoffs.map((c: any) => c.id)).toEqual([page1.items[0].id]);

    const detail = ConversationDetail.parse((await v.get(`/api/merchant/conversations/${page2.items[0].id}`)).json());
    expect(detail.bookings).toEqual([expect.objectContaining({ date: WED, time: "11:00", status: "confirmed", source: "web" })]);
    expect(detail.trace.llmCalls.flatMap((c) => c.toolCalls.map((t) => t.name))).toEqual([
      "save_customer_contact",
      "hold_slot",
      "confirm_booking",
    ]);
    expect(detail.trace.messages[0]).toMatchObject({ author: "customer" });

    expect((await v.get("/api/merchant/conversations?cursor=basura")).statusCode).toBe(422);
  });
});

describe("aislamiento entre negocios", () => {
  it("ninguno ve ni toca lo del otro, aunque use ids válidos del otro", async () => {
    await book(AURORA.services.corteMujer, WED, "11:00");
    const marta = await as(NORTE.owner.email);

    expect((await marta.get("/api/merchant/business")).json()).toMatchObject({ name: "Barbería Norte", timezone: "America/Chicago" });
    expect((await marta.get("/api/merchant/services")).json().map((s: any) => s.name)).toEqual(["Barba"]);
    expect((await marta.get(`/api/merchant/bookings?from=${WED}&to=${WED}`)).json().items).toEqual([]);

    // ids del Salón Aurora desde la Barbería Norte
    expect((await send(marta, "PATCH", `/api/merchant/services/${AURORA.services.color}`, { name: "Robado" })).statusCode).toBe(404);
    expect((await send(marta, "PATCH", `/api/merchant/staff/${AURORA.staff.valeria}`, { active: false })).statusCode).toBe(404);
    expect((await send(marta, "PUT", `/api/merchant/staff/${AURORA.staff.valeria}/schedule`, { schedule: null })).statusCode).toBe(404);
    expect(
      (await send(marta, "POST", "/api/merchant/closures", { from: WED, to: WED, staffId: AURORA.staff.valeria })).statusCode,
    ).toBe(404);
    const auroraConv = await admin.query("SELECT id FROM conversations WHERE tenant_id = $1 LIMIT 1", [AURORA.tenant]);
    if (auroraConv.rows[0]) {
      expect((await marta.get(`/api/merchant/conversations/${auroraConv.rows[0].id}`)).statusCode).toBe(404);
    }
    const thanksgiving = (await (await valeria()).get("/api/merchant/closures")).json()[0].id;
    expect((await send(marta, "DELETE", `/api/merchant/closures/${thanksgiving}`)).statusCode).toBe(404);

    // nada cambió en el Salón Aurora
    const svc = await admin.query("SELECT name FROM services WHERE id = $1", [AURORA.services.color]);
    expect(svc.rows[0].name).toBe("Color");
    const staff = await admin.query("SELECT is_active FROM resources WHERE id = $1", [AURORA.staff.valeria]);
    expect(staff.rows[0].is_active).toBe(true);
    expect((await admin.query("SELECT count(*)::int AS n FROM availability_exceptions WHERE tenant_id = $1", [AURORA.tenant])).rows[0].n).toBe(1);
  });
});
