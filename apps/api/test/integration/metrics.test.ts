import { Metrics } from "@hablahora/contracts";
import { BookingService, MemoryEmailSender, type ConversationContext, type StaffContext } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";

/** Métricas del negocio con datos conocidos. */

const TZ = AURORA.timezone;
const WED = "2026-10-14"; // Valeria 9–19 (600 min), Camila 9–15 (360 min), Diego no trabaja
const S = AURORA.services;
const P = AURORA.staff;

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let now: Date;
let bookings: BookingService;
let server: ReturnType<typeof buildServer>;

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
  server = buildServer({ auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock, bookings } });
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
  now = DateTime.fromISO("2026-10-12T12:00", { zone: TZ }).toJSDate();
});

const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toJSDate();
const staff: StaffContext = { tenantId: AURORA.tenant, locationId: AURORA.location, userId: "u-test" };
const customer = (n: number) => ({ name: `Cliente ${n}`, phone: `+1305555010${n}` });

async function staffBooking(serviceId: string, time: string, staffId: string, n: number) {
  const r = await bookings.staffCreateBooking(staff, { serviceId, date: WED, time, staffId, customer: customer(n) });
  if (!r.ok) throw new Error(r.reason);
  return r.booking.id;
}

/** Conversación del chat web con mensajes a mano (sin modelo). */
async function conversation(a: { customer?: boolean; handoffAt?: Date; staffReplyAt?: Date; createdAt?: Date }) {
  const { rows } = await admin.query(
    `INSERT INTO conversations (tenant_id, location_id, channel, external_id, handoff, handoff_at, created_at)
     VALUES ($1, $2, 'web', gen_random_uuid()::text, $3, $4, $5) RETURNING id`,
    [AURORA.tenant, AURORA.location, !!a.handoffAt, a.handoffAt ?? null, a.createdAt ?? at(WED, "08:00")],
  );
  const id = rows[0].id;
  const msg = (author: string, role: string, createdAt: Date) =>
    admin.query(
      `INSERT INTO conversation_messages (tenant_id, conversation_id, role, content, author, created_at)
       VALUES ($1, $2, $3, '[{"type":"text","text":"hola"}]', $4, $5)`,
      [AURORA.tenant, id, role, author, createdAt],
    );
  if (a.customer !== false) await msg("customer", "user", a.createdAt ?? at(WED, "08:00"));
  if (a.staffReplyAt) await msg("staff", "assistant", a.staffReplyAt);
  return id as string;
}

describe("métricas", () => {
  it("reservas por estado y origen, servicios, chat y ocupación", async () => {
    // Valeria: corte 60 + color 120 confirmadas (equipo)
    await staffBooking(S.corteMujer, "09:00", P.valeria, 1);
    await staffBooking(S.color, "13:00", P.valeria, 2);
    // Camila: una manicure cancelada (no ocupa) y otra que no vino (sí ocupa)
    const cancelled = await staffBooking(S.manicure, "10:00", P.camila, 3);
    await bookings.staffCancel(staff, cancelled);
    const noShow = await staffBooking(S.manicure, "11:00", P.camila, 4);
    // una reserva del chat, ligada a su conversación
    const withBooking = await conversation({});
    const c: ConversationContext = {
      tenantId: AURORA.tenant,
      locationId: AURORA.location,
      channel: "whatsapp",
      verifiedPhone: "+56955550199",
      conversationId: withBooking,
    };
    const hold = await bookings.holdSlot(c, { serviceId: S.corteMujer, date: WED, time: "12:00", partySize: 1, customerName: "Rosa" });
    if (!hold.ok) throw new Error(hold.reason);
    await bookings.confirmBooking(c, hold.booking.id);
    now = at(WED, "12:00");
    await bookings.staffSetStatus(staff, noShow, "no_show");

    // chat: una que pasó al equipo y se respondió a los 4 min, una sin reserva, una sin mensajes del cliente
    await conversation({ handoffAt: at(WED, "09:00"), staffReplyAt: at(WED, "09:04") });
    await conversation({});
    await conversation({ customer: false });
    // fuera del período: no cuenta
    await conversation({ createdAt: at("2026-10-20", "10:00") });

    const b = browser(server.app);
    await b.signIn(AURORA_USERS.camila.email, DEV_PASSWORD); // el staff también las ve
    const m = Metrics.parse((await b.get(`/api/merchant/metrics?from=${WED}&to=${WED}`)).json());

    expect(m.totals).toEqual({ pending: 0, confirmed: 3, completed: 0, noShow: 1, cancelled: 1, booked: 4 });
    expect(m.days).toEqual([{ date: WED, pending: 0, confirmed: 3, completed: 0, noShow: 1, cancelled: 1 }]);
    expect(m.bySource).toEqual([
      { source: "staff", count: 3 },
      { source: "whatsapp", count: 1 },
    ]);
    expect(m.topServices.map((s) => [s.name, s.count])).toEqual([
      ["Corte de mujer", 2],
      ["Color", 1],
      ["Manicure", 1],
    ]);
    expect(m.chat).toEqual({ conversations: 3, withBooking: 1, handedOff: 1, medianTeamReplyMin: 4 });
    expect(m.occupancy).toEqual([
      // corte 60 + color 120 (la limpieza del color no cuenta)
      { staffId: P.valeria, name: "Valeria", bookedMin: 180, availableMin: 600, ratio: 0.3 },
      // la que no vino 45 + el corte del chat 60 (lo tomó Camila); la cancelada no cuenta
      { staffId: P.camila, name: "Camila", bookedMin: 105, availableMin: 360, ratio: 105 / 360 },
      { staffId: P.diego, name: "Diego", bookedMin: 0, availableMin: 0, ratio: null },
    ]);
  });

  it("un día por fecha del período (aunque no haya reservas); rango de hasta 92 días", async () => {
    const b = browser(server.app);
    await b.signIn(AURORA_USERS.valeria.email, DEV_PASSWORD);
    const m = Metrics.parse((await b.get("/api/merchant/metrics?from=2026-10-01&to=2026-10-07")).json());
    expect(m.days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(m.chat).toEqual({ conversations: 0, withBooking: 0, handedOff: 0, medianTeamReplyMin: null });
    // Valeria trabaja martes a sábado 9–19: 5 días × 600 min
    expect(m.occupancy[0]).toMatchObject({ name: "Valeria", availableMin: 3000, bookedMin: 0, ratio: 0 });
    expect((await b.get("/api/merchant/metrics?from=2026-01-01&to=2026-10-07")).statusCode).toBe(400);
    expect((await server.app.inject({ url: "/api/merchant/metrics?from=2026-10-01&to=2026-10-07" })).statusCode).toBe(401);
  });
});
