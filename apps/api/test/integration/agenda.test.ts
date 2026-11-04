import { BookingList, CustomerSearchResult, DayAgenda, MerchantBooking, StaffAvailability } from "@hablahora/contracts";
import { BookingService, MemoryEmailSender, type ConversationContext } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";

/** Agenda del día y reservas hechas o cambiadas por el equipo desde la consola. */

const TZ = AURORA.timezone;
const WED = "2026-10-14"; // Valeria 9–19, Camila 9–15, Diego no trabaja
const THU = "2026-10-15";
const S = AURORA.services;
const P = AURORA.staff;

/** Otro negocio con una reserva: nadie de Aurora debe verla ni tocarla. */
const OTRO = {
  tenant: "d0d0d0d0-0000-4000-8000-000000000001",
  location: "d0d0d0d0-0000-4000-8000-000000000002",
  staff: "d0d0d0d0-0000-4000-8000-000000000101",
  service: "d0d0d0d0-0000-4000-8000-000000000201",
  customer: "d0d0d0d0-0000-4000-8000-000000000301",
  booking: "d0d0d0d0-0000-4000-8000-000000000401",
};

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let now: Date;
let bookings: BookingService;
let server: ReturnType<typeof buildServer>;
const email = new MemoryEmailSender();

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
  server = buildServer({ auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock, bookings, email } });
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
  now = at("2026-10-12", "12:00"); // lunes
  email.sent = [];
});

const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toJSDate();

const as = async (who: keyof typeof AURORA_USERS) => {
  const b = browser(server.app);
  expect((await b.signIn(AURORA_USERS[who].email, DEV_PASSWORD)).statusCode).toBe(200);
  const post = (url: string, payload: unknown = {}, origin: string | null = ORIGIN) =>
    server.app.inject({
      method: "POST",
      url,
      payload: payload as any,
      headers: { cookie: b.cookie, ...(origin ? { origin } : {}) },
    });
  return { ...b, post };
};

const agenda = async (b: Awaited<ReturnType<typeof as>>, date: string) => DayAgenda.parse((await b.get(`/api/merchant/agenda?date=${date}`)).json());

/** Reserva confirmada con el motor, como si viniera del chat (sin email del cliente). */
async function bookFromChat(serviceId: string, date: string, time: string, phone = "+13055550001") {
  const c: ConversationContext = { tenantId: AURORA.tenant, locationId: AURORA.location, channel: "whatsapp", verifiedPhone: phone };
  const h = await bookings.holdSlot(c, { serviceId, date, time, partySize: 1, customerName: "Rosa" });
  if (!h.ok) throw new Error(`no se pudo apartar: ${h.reason}`);
  await bookings.confirmBooking(c, h.booking.id);
  return h.booking.id;
}

const newCustomer = { name: "Lucía Pérez", phone: "9 5555 0199", email: "lucia@example.com" };

// ---------------------------------------------------------------------

describe("agenda del día", () => {
  it("horario de la sucursal y de cada profesional, y solo las reservas vigentes", async () => {
    const kept = await bookFromChat(S.corteMujer, WED, "10:00");
    const cancelled = await bookFromChat(S.manicure, WED, "11:00", "+13055550002");
    await admin.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [cancelled]);
    // apartado vencido: ya no ocupa la agenda
    await bookings.holdSlot(
      { tenantId: AURORA.tenant, locationId: AURORA.location, channel: "whatsapp", verifiedPhone: "+13055550003" },
      { serviceId: S.peinado, date: WED, time: "15:00", partySize: 1, customerName: "Ana" },
    );
    now = new Date(now.getTime() + 10 * 60_000);

    const camila = await as("camila");
    const day = await agenda(camila, WED);
    expect(day.open).toEqual([{ start: 540, end: 1140 }]);
    expect(day.staff.map((s) => [s.name, s.windows])).toEqual([
      ["Valeria", [{ start: 540, end: 1140 }]],
      ["Camila", [{ start: 540, end: 900 }]],
      ["Diego", []],
    ]);
    expect(day.bookings.map((b) => b.id)).toEqual([kept]);
    expect(day.bookings[0]).toMatchObject({ time: "10:00", endTime: "11:00", startMin: 600, endMin: 660, status: "confirmed" });
    expect(day.bookings[0].customer).toMatchObject({ name: "Rosa", phone: "+13055550001" });
  });

  it("un feriado cierra el día para todos", async () => {
    const v = await as("valeria");
    const day = await agenda(v, "2026-11-26");
    expect(day.open).toEqual([]);
    expect(day.staff.every((s) => s.windows.length === 0)).toBe(true);
  });

  it("fecha inválida: 400", async () => {
    const v = await as("valeria");
    expect((await v.get("/api/merchant/agenda?date=2026-02-30")).statusCode).toBe(400);
  });
});

describe("reserva creada por el equipo", () => {
  it("el staff también puede: queda confirmada, con autor, y el cliente recibe el aviso", async () => {
    const camila = await as("camila");
    const res = await camila.post("/api/merchant/bookings", {
      serviceId: S.manicure,
      date: WED,
      time: "09:30",
      customer: newCustomer,
      notes: "Prefiere esmalte nude",
    });
    expect(res.statusCode).toBe(201);
    const booking = MerchantBooking.parse(res.json());
    expect(booking).toMatchObject({
      status: "confirmed",
      source: "staff",
      time: "09:30",
      staff: { id: P.camila },
      customer: { name: "Lucía Pérez", phone: "+56955550199", email: "lucia@example.com" },
      notes: "Prefiere esmalte nude",
    });

    const events = await admin.query("SELECT event, actor FROM booking_events WHERE booking_id = $1 ORDER BY id", [booking.id]);
    const userId = (await authDb.query(`SELECT id FROM "user" WHERE email = $1`, [AURORA_USERS.camila.email])).rows[0].id;
    expect(events.rows).toEqual([
      { event: "created", actor: `staff:${userId}` },
      { event: "confirmed", actor: `staff:${userId}` },
    ]);

    const mail = email.lastTo("lucia@example.com")!;
    expect(mail.subject).toBe("Reserva confirmada — Salón Aurora");
    expect(mail.text).toContain("Manicure con Camila, miércoles 14 de octubre a las 09:30.");

    // el mismo cliente se encuentra después por nombre o por teléfono
    const found = CustomerSearchResult.parse((await camila.get("/api/merchant/customers?q=luc")).json());
    expect(found.items).toEqual([{ id: booking.customer!.id, name: "Lucía Pérez", phone: "+56955550199", email: "lucia@example.com" }]);
    const byPhone = CustomerSearchResult.parse((await camila.get("/api/merchant/customers?q=5555%200199")).json());
    expect(byPhone.items.map((c) => c.name)).toEqual(["Lucía Pérez"]);
  });

  it("con un cliente existente; sin profesional elige al primero libre", async () => {
    await bookFromChat(S.corteMujer, WED, "10:00"); // Valeria
    const v = await as("valeria");
    const customers = CustomerSearchResult.parse((await v.get("/api/merchant/customers?q=Rosa")).json());
    const res = await v.post("/api/merchant/bookings", {
      serviceId: S.corteMujer,
      date: WED,
      time: "10:00",
      customer: { id: customers.items[0].id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ staff: { name: "Camila" }, customer: { name: "Rosa" } });
    expect(email.sent).toEqual([]); // sin email, sin aviso
  });

  it("dentro del horario: puede ser para ya mismo, pero nunca encima de otra ni en el pasado", async () => {
    const v = await as("valeria");
    const make = (time: string, extra: object = {}) =>
      v.post("/api/merchant/bookings", { serviceId: S.color, date: "2026-10-13", time, staffId: P.valeria, customer: newCustomer, ...extra });

    now = at("2026-10-13", "10:05");
    expect((await make("10:15")).statusCode).toBe(201); // sin anticipación mínima
    const overlap = await make("11:00");
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json()).toMatchObject({ reason: "slot_unavailable" });
    expect((await make("09:00")).json()).toMatchObject({ reason: "in_past" });
    // Diego no hace color
    expect((await make("15:00", { staffId: P.diego })).json()).toMatchObject({ reason: "staff_not_found" });
  });

  it("fuera de horario solo si se marca, y tampoco encima de otra reserva", async () => {
    const v = await as("valeria");
    const make = (time: string, outsideHours: boolean) =>
      v.post("/api/merchant/bookings", { serviceId: S.peinado, date: WED, time, staffId: P.valeria, customer: newCustomer, outsideHours });

    expect((await make("19:30", false)).json()).toMatchObject({ reason: "slot_unavailable" });
    const late = await make("19:30", true);
    expect(late.statusCode).toBe(201);
    expect(late.json()).toMatchObject({ time: "19:30", endTime: "20:15" });
    const taken = await make("20:00", true);
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ reason: "slot_taken" });

    const day = await agenda(v, WED);
    expect(day.bookings.map((b) => [b.time, b.startMin, b.endMin])).toEqual([["19:30", 1170, 1215]]);
  });

  it("datos del cliente: nombre y teléfono o email válidos", async () => {
    const v = await as("valeria");
    const make = (customer: object) => v.post("/api/merchant/bookings", { serviceId: S.peinado, date: WED, time: "10:00", customer });
    expect((await make({ name: "Sin contacto" })).statusCode).toBe(400);
    const bad = await make({ name: "Ana", phone: "12" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ reason: "invalid_customer" });
    expect((await make({ id: OTRO.customer })).json()).toMatchObject({ reason: "invalid_customer" });
  });
});

describe("cambios del equipo sobre una reserva", () => {
  it("mover a otro día y profesional: una nueva reserva, la anterior cancelada, aviso en el idioma del cliente", async () => {
    await admin.query("UPDATE locations SET default_locale = 'en' WHERE id = $1", [AURORA.location]);
    const v = await as("valeria");
    const created = MerchantBooking.parse(
      (await v.post("/api/merchant/bookings", { serviceId: S.corteMujer, date: WED, time: "10:00", staffId: P.valeria, customer: newCustomer })).json(),
    );
    email.sent = [];

    const res = await v.post(`/api/merchant/bookings/${created.id}/reschedule`, { date: THU, time: "11:00", staffId: P.camila });
    expect(res.statusCode).toBe(200);
    const moved = MerchantBooking.parse(res.json());
    expect(moved).toMatchObject({ date: THU, time: "11:00", status: "confirmed", staff: { id: P.camila } });
    expect(moved.id).not.toBe(created.id);

    const old = await admin.query("SELECT status FROM bookings WHERE id = $1", [created.id]);
    expect(old.rows[0].status).toBe("cancelled");
    expect((await agenda(v, WED)).bookings).toEqual([]);
    expect((await agenda(v, THU)).bookings.map((b) => b.id)).toEqual([moved.id]);

    const mail = email.lastTo("lucia@example.com")!;
    expect(mail.subject).toBe("Booking moved — Salón Aurora");
    expect(mail.text).toContain("New time: Corte de mujer with Camila, Thursday, October 15 at 11:00 AM.");
  });

  it("mover media hora dentro de su propio horario; si no cabe, la reserva queda intacta", async () => {
    const id = await bookFromChat(S.color, WED, "10:00"); // Valeria, 10:00–12:00 + 15 min
    await bookFromChat(S.peinado, WED, "13:00", "+13055550002"); // Valeria
    const v = await as("valeria");

    const shift = await v.post(`/api/merchant/bookings/${id}/reschedule`, { date: WED, time: "10:30" });
    expect(shift.statusCode).toBe(200);
    const shifted = MerchantBooking.parse(shift.json());

    const blocked = await v.post(`/api/merchant/bookings/${shifted.id}/reschedule`, { date: WED, time: "12:00" });
    expect(blocked.json()).toMatchObject({ reason: "slot_unavailable" });
    const still = await admin.query("SELECT status FROM bookings WHERE id = $1", [shifted.id]);
    expect(still.rows[0].status).toBe("confirmed");
    expect((await agenda(v, WED)).bookings.map((b) => b.time)).toEqual(["10:30", "13:00"]);
  });

  it("cancelar aunque haya pasado el plazo del cliente; una cancelada ya no cambia", async () => {
    const id = await bookFromChat(S.corteMujer, WED, "10:00");
    await admin.query("UPDATE customers SET email = 'rosa@example.com' WHERE phone_e164 = '+13055550001'");
    now = at(WED, "09:50");
    const camila = await as("camila");

    const res = await camila.post(`/api/merchant/bookings/${id}/cancel`, { reason: "Se enfermó la profesional" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled" });
    const ev = await admin.query("SELECT payload FROM booking_events WHERE booking_id = $1 AND event = 'cancelled'", [id]);
    expect(ev.rows[0].payload).toMatchObject({ reason: "Se enfermó la profesional", channel: "staff" });
    expect(email.lastTo("rosa@example.com")!.text).toContain("Salón Aurora canceló tu reserva.");

    const again = await camila.post(`/api/merchant/bookings/${id}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "booking_not_allowed" });
    expect((await camila.post(`/api/merchant/bookings/${id}/reschedule`, { date: THU, time: "10:00" })).json()).toMatchObject({
      reason: "booking_not_allowed",
    });
  });

  it("confirmar una pendiente", async () => {
    const id = await bookFromChat(S.corteMujer, WED, "10:00");
    await admin.query("UPDATE bookings SET status = 'pending' WHERE id = $1", [id]);
    const v = await as("valeria");
    expect((await v.post(`/api/merchant/bookings/${id}/confirm`)).json()).toMatchObject({ status: "confirmed" });
    expect((await v.post(`/api/merchant/bookings/${id}/confirm`)).json()).toMatchObject({ reason: "booking_not_allowed" });
  });

  it("atendida o no vino: solo desde la hora de inicio", async () => {
    const id = await bookFromChat(S.corteMujer, WED, "10:00");
    const v = await as("valeria");
    expect((await v.post(`/api/merchant/bookings/${id}/status`, { status: "completed" })).statusCode).toBe(409);
    now = at(WED, "10:00");
    expect((await v.post(`/api/merchant/bookings/${id}/status`, { status: "no_show" })).json()).toMatchObject({ status: "no_show" });
    expect((await v.post(`/api/merchant/bookings/${id}/status`, { status: "completed" })).json()).toMatchObject({ status: "completed" });
    expect((await v.post(`/api/merchant/bookings/${id}/status`, { status: "cancelled" })).statusCode).toBe(400);
    expect(email.sent).toEqual([]);
  });
});

describe("horas libres para el equipo", () => {
  it("por profesional, y al mover cuenta como libre el horario de la propia reserva", async () => {
    const id = await bookFromChat(S.manicure, WED, "10:00"); // Camila, 10:00–10:45
    const v = await as("valeria");
    const free = async (extra = "") =>
      StaffAvailability.parse(
        (await v.get(`/api/merchant/availability?serviceId=${S.manicure}&date=${WED}&staffId=${P.camila}${extra}`)).json(),
      ).times.map((t) => t.time);

    const before = await free();
    expect(before).not.toContain("10:00");
    expect(before.at(-1)).toBe("14:15"); // Camila sale a las 15:00
    expect(await free(`&bookingId=${id}`)).toContain("10:00");
    // la consulta no cambió nada
    expect((await agenda(v, WED)).bookings.map((b) => b.id)).toEqual([id]);
  });
});

describe("listado", () => {
  it("busca por nombre, teléfono o email del cliente", async () => {
    await bookFromChat(S.corteMujer, WED, "10:00");
    await bookFromChat(S.manicure, WED, "11:00", "+13055550002");
    await admin.query("UPDATE customers SET name = 'Marta Gómez' WHERE phone_e164 = '+13055550002'");
    const v = await as("valeria");
    const list = async (q: string) =>
      BookingList.parse((await v.get(`/api/merchant/bookings?from=${WED}&to=${WED}&q=${encodeURIComponent(q)}`)).json()).items.map(
        (b) => b.customer?.name,
      );
    expect(await list("marta")).toEqual(["Marta Gómez"]);
    expect(await list("555-0001")).toEqual(["Rosa"]);
    expect(await list("50%")).toEqual([]);
  });
});

describe("permisos y aislamiento", () => {
  beforeEach(async () => {
    for (const t of ["booking_events", "booking_resources", "bookings", "customers", "service_resources", "services", "resources", "locations"]) {
      await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [OTRO.tenant]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [OTRO.tenant]);
    await admin.query(`INSERT INTO tenants (id, name, vertical) VALUES ($1, 'Otro', 'salon')`, [OTRO.tenant]);
    await admin.query(`INSERT INTO locations (id, tenant_id, name, timezone) VALUES ($1, $2, 'X', $3)`, [OTRO.location, OTRO.tenant, TZ]);
    await admin.query(`INSERT INTO resources (id, tenant_id, location_id, kind, name) VALUES ($1, $2, $3, 'staff', 'Tomás')`, [
      OTRO.staff,
      OTRO.tenant,
      OTRO.location,
    ]);
    await admin.query(
      `INSERT INTO services (id, tenant_id, location_id, name, resource_kind, duration_min) VALUES ($1, $2, $3, 'Barba', 'staff', 30)`,
      [OTRO.service, OTRO.tenant, OTRO.location],
    );
    await admin.query(`INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES ($1, $2, 'Rosa Otra', '+13055550001')`, [
      OTRO.customer,
      OTRO.tenant,
    ]);
    await admin.query(
      `INSERT INTO bookings (id, tenant_id, location_id, service_id, customer_id, starts_at, ends_at, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', 'staff')`,
      [OTRO.booking, OTRO.tenant, OTRO.location, OTRO.service, OTRO.customer, at(WED, "10:00"), at(WED, "10:30")],
    );
  });

  it("sin sesión 401; sin origen de la consola 403", async () => {
    expect((await server.app.inject({ url: `/api/merchant/agenda?date=${WED}` })).statusCode).toBe(401);
    const camila = await as("camila");
    const body = { serviceId: S.manicure, date: WED, time: "10:00", customer: newCustomer };
    expect((await camila.post("/api/merchant/bookings", body, null)).statusCode).toBe(403);
    expect((await camila.post("/api/merchant/bookings", body, "https://malicioso.example")).statusCode).toBe(403);
  });

  it("no se ve ni se toca nada de otro negocio", async () => {
    const v = await as("valeria");
    expect((await agenda(v, WED)).bookings).toEqual([]);
    for (const action of ["confirm", "cancel"]) {
      const res = await v.post(`/api/merchant/bookings/${OTRO.booking}/${action}`);
      expect(res.statusCode).toBe(404);
    }
    expect((await v.post(`/api/merchant/bookings/${OTRO.booking}/reschedule`, { date: THU, time: "10:00" })).statusCode).toBe(404);
    expect(CustomerSearchResult.parse((await v.get("/api/merchant/customers?q=Rosa")).json()).items).toEqual([]);
    const other = await v.post("/api/merchant/bookings", { serviceId: OTRO.service, date: WED, time: "10:00", customer: newCustomer });
    expect(other.statusCode).toBe(404);
    expect((await admin.query("SELECT status FROM bookings WHERE id = $1", [OTRO.booking])).rows[0].status).toBe("confirmed");
  });
});
