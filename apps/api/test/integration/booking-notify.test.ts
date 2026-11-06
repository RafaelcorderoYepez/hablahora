import { BookingService, MemoryEmailSender, type ConversationContext } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { bookingNotifier } from "../../src/booking-notify.js";
import { AURORA_USERS, seedAuroraUsers } from "../../src/seed-users.js";
import { ORIGIN } from "../../../../test/support/auth.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";

/** Aviso a los administradores cuando un cliente reserva, mueve o cancela. */

const TUE = "2026-10-13";
const ctx: ConversationContext = {
  tenantId: AURORA.tenant,
  locationId: AURORA.location,
  verifiedPhone: "+56912345678",
  channel: "whatsapp",
};

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let svc: BookingService;
const email = new MemoryEmailSender();
const now = DateTime.fromISO("2026-10-12T12:00", { zone: AURORA.timezone }).toJSDate();
const clock = () => now;

const hold = async (time: string) => {
  const r = await svc.holdSlot(ctx, { serviceId: AURORA.services.corteMujer, date: TUE, time, partySize: 1, customerName: "Ana Pérez" });
  if (!r.ok) throw new Error(`no se pudo apartar: ${r.reason}`);
  return r.booking.id;
};
const book = async (time: string) => {
  const id = await hold(time);
  const r = await svc.confirmBooking(ctx, id);
  expect(r.ok).toBe(true);
  return id;
};

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
  svc = new BookingService(app, clock, bookingNotifier({ db: app, authDb, email, consoleURL: "http://consola.test/" }));
});

afterAll(async () => {
  await authDb.end();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await seedSalonAurora(admin);
  await seedAuroraUsers({ auth, authDb, adminDb: admin, tenantId: AURORA.tenant, slug: AURORA.slug });
  await authDb.query(`UPDATE "user" SET locale = 'es' WHERE email = $1`, [AURORA_USERS.valeria.email]);
  email.sent = [];
});

describe("aviso de reservas al negocio", () => {
  it("una reserva nueva llega a los administradores, no al staff, con los datos del cliente y la agenda del día", async () => {
    await book("11:00");
    expect(email.sent.map((m) => m.to)).toEqual([AURORA_USERS.valeria.email]);
    const [m] = email.sent;
    expect(m.subject).toContain("nueva reserva");
    expect(m.text).toContain("Ana Pérez");
    expect(m.text).toContain("+56912345678");
    expect(m.text).toContain("a las 11:00");
    expect(m.text).toContain(`http://consola.test/agenda?date=${TUE}`);
  });

  it("apartar no avisa, y soltar un apartado tampoco", async () => {
    const id = await hold("11:00");
    expect((await svc.cancelBooking(ctx, id)).ok).toBe(true);
    expect(email.sent).toEqual([]);
  });

  it("si el negocio confirma a mano, avisa que está esperando su confirmación", async () => {
    await admin.query("UPDATE booking_policies SET auto_confirm = false WHERE tenant_id = $1", [AURORA.tenant]);
    await book("11:00");
    expect(email.sent[0].subject).toContain("esperando tu confirmación");
  });

  it("mover avisa el horario nuevo y el anterior; cancelar una reserva firme también avisa", async () => {
    const id = await book("11:00");
    email.sent = [];
    const moved = await svc.rescheduleBooking(ctx, id, { date: TUE, time: "15:00" });
    if (!moved.ok) throw new Error(moved.reason);
    expect(email.sent[0].text).toContain("a las 15:00");
    expect(email.sent[0].text).toMatch(/Antes era: .*a las 11:00/);

    email.sent = [];
    expect((await svc.cancelBooking(ctx, moved.booking.id)).ok).toBe(true);
    expect(email.sent[0].subject).toContain("canceló");
  });

  it("lo que hace el equipo desde la consola no se avisa", async () => {
    const r = await svc.staffCreateBooking(
      { tenantId: AURORA.tenant, locationId: AURORA.location, userId: "usuario-de-prueba" },
      { serviceId: AURORA.services.corteMujer, date: TUE, time: "11:00", customer: { name: "Ana Pérez", phone: "+56912345678" } },
    );
    expect(r.ok).toBe(true);
    expect(email.sent).toEqual([]);
  });

  it("llega en el idioma de cada administrador", async () => {
    await authDb.query(`UPDATE "user" SET locale = 'en' WHERE email = $1`, [AURORA_USERS.valeria.email]);
    await book("11:00");
    expect(email.sent[0].subject).toContain("new booking");
    expect(email.sent[0].text).toContain("Customer: Ana Pérez");
  });

  it("si el correo falla, la reserva queda hecha y la herramienta no falla", async () => {
    const failing = new BookingService(
      app,
      clock,
      bookingNotifier({ db: app, authDb, consoleURL: "http://consola.test", email: { send: () => Promise.reject(new Error("sin correo")) } }),
    );
    const held = await failing.holdSlot(ctx, { serviceId: AURORA.services.corteMujer, date: TUE, time: "11:00", partySize: 1, customerName: "Ana" });
    if (!held.ok) throw new Error(held.reason);
    const r = await failing.confirmBooking(ctx, held.booking.id);
    expect(r).toMatchObject({ ok: true, booking: { status: "confirmed" } });
  });
});
