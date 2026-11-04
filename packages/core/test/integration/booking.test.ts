import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BookingService, handleBookingTool, type ConversationContext } from "../../src/index.js";
import { clearBookings, IDS, seed } from "../../../../test/support/fixtures.js";
import { ADMIN_URL, APP_URL } from "../../../../test/support/global-setup.js";

const NY = "America/New_York";
const TUE = "2026-10-13";
const CONV1 = "c0000000-0000-4000-8000-000000000001";
const CONV2 = "c0000000-0000-4000-8000-000000000002";
const ny = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: NY }).toJSDate();

let admin: pg.Pool;
let app: pg.Pool;
let now: Date;
let svc: BookingService;

const ctxA = (phone = "+13055550001", conversationId?: string): ConversationContext => ({
  tenantId: IDS.tenantA,
  locationId: IDS.locA,
  verifiedPhone: phone,
  conversationId,
  channel: "whatsapp",
});
const ctxB = (phone = "+13055550001"): ConversationContext => ({
  tenantId: IDS.tenantB,
  locationId: IDS.locB,
  verifiedPhone: phone,
  channel: "whatsapp",
});

const hold = (ctx: ConversationContext, time: string, partySize = 2, date = TUE) =>
  svc.holdSlot(ctx, { serviceId: IDS.cena, date, time, partySize });

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 }); // rol sin BYPASSRLS
  await seed(admin);
  svc = new BookingService(app, () => now);
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await clearBookings(admin);
  now = ny("2026-10-12", "12:00");
});

describe("disponibilidad", () => {
  it("devuelve opciones cerca de la hora pedida", async () => {
    const r = await svc.checkAvailability(ctxA(), {
      serviceId: IDS.cena,
      date: TUE,
      partySize: 2,
      preferredTime: "20:00",
    });
    expect(r.slots.map((s) => s.time)).toEqual(["19:30", "19:45", "20:00", "20:15"]);
    expect(r.slots[0].resourceName).toBe("Mesa 1");
  });

  it("los holds de otros clientes ocupan la mesa", async () => {
    await hold(ctxA("+1001"), "20:00");
    const r = await svc.checkAvailability(ctxA("+1002"), {
      serviceId: IDS.cena,
      date: TUE,
      partySize: 2,
      preferredTime: "20:00",
    });
    expect(r.slots.find((s) => s.time === "20:00")!.resourceName).toBe("Mesa 2");
  });
});

describe("hold", () => {
  it("aparta la mesa más chica y la siguiente va a la otra", async () => {
    const a = await hold(ctxA("+1001"), "20:00");
    const b = await hold(ctxA("+1002"), "20:00");
    const c = await hold(ctxA("+1003"), "20:00");
    expect(a.ok && a.booking.resourceNames).toEqual(["Mesa 1"]);
    expect(b.ok && b.booking.resourceNames).toEqual(["Mesa 2"]);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe("slot_unavailable");
      expect(c.alternatives.length).toBeGreaterThan(0);
      expect(c.alternatives.map((x) => x.time)).not.toContain("20:00");
    }
  });

  it("carrera real: 6 clientes por la única mesa que sirve, gana uno solo", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => hold(ctxA(`+20${i}`), "20:00", 3)), // solo Mesa 2 admite 3
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(["slot_taken", "slot_unavailable"]).toContain(!r.ok && r.reason);
    }
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM booking_resources WHERE is_active");
    expect(rows[0].n).toBe(1);
  });

  it("un hold vencido libera el horario", async () => {
    const a = await hold(ctxA("+1001"), "20:00", 3);
    expect(a.ok).toBe(true);
    expect((await hold(ctxA("+1002"), "20:00", 3)).ok).toBe(false);
    now = new Date(now.getTime() + 6 * 60_000); // TTL de 5 min
    expect((await hold(ctxA("+1002"), "20:00", 3)).ok).toBe(true);
  });

  it("cambiar de idea en la misma conversación suelta el hold anterior", async () => {
    await hold(ctxA("+1001", CONV1), "20:00", 3);
    await hold(ctxA("+1001", CONV1), "18:00", 3); // termina justo a las 20:00
    const other = await hold(ctxA("+1002"), "20:00", 3);
    expect(other.ok).toBe(true);
  });

  it("rechaza un horario fuera de la grilla o del horario de atención", async () => {
    expect((await hold(ctxA(), "20:07")).ok).toBe(false);
    const late = await hold(ctxA(), "22:30");
    expect(late.ok).toBe(false);
  });
});

describe("confirmar y cancelar", () => {
  it("confirma un hold vigente", async () => {
    const h = await hold(ctxA(), "20:00");
    if (!h.ok) throw new Error("hold falló");
    const c = await svc.confirmBooking(ctxA(), h.booking.id);
    expect(c.ok && c.booking.status).toBe("confirmed");
  });

  it("no confirma un hold vencido", async () => {
    const h = await hold(ctxA(), "20:00");
    if (!h.ok) throw new Error("hold falló");
    now = new Date(now.getTime() + 10 * 60_000);
    expect(await svc.confirmBooking(ctxA(), h.booking.id)).toEqual({ ok: false, reason: "hold_expired" });
  });

  it("un cliente no puede confirmar ni cancelar la reserva de otro", async () => {
    const h = await hold(ctxA("+1001"), "20:00");
    if (!h.ok) throw new Error("hold falló");
    expect((await svc.confirmBooking(ctxA("+1999"), h.booking.id)).ok).toBe(false);
    expect((await svc.cancelBooking(ctxA("+1999"), h.booking.id)).ok).toBe(false);
  });

  it("negocio con confirmación manual deja la reserva en 'pending'", async () => {
    const h = await svc.holdSlot(ctxB(), { serviceId: IDS.corte, date: TUE, time: "10:00", partySize: 1 });
    if (!h.ok) throw new Error("hold falló");
    const c = await svc.confirmBooking(ctxB(), h.booking.id);
    expect(c.ok && c.booking.status).toBe("pending");
  });

  it("cancelar libera la mesa; fuera del plazo se rechaza", async () => {
    const h = await hold(ctxA(), "20:00", 3);
    if (!h.ok) throw new Error("hold falló");
    await svc.confirmBooking(ctxA(), h.booking.id);

    expect((await svc.cancelBooking(ctxA(), h.booking.id)).ok).toBe(true);
    expect((await hold(ctxA("+1002"), "20:00", 3)).ok).toBe(true);

    const late = await hold(ctxA("+1003"), "21:00", 2); // Mesa 1
    if (!late.ok) throw new Error("hold falló");
    await svc.confirmBooking(ctxA("+1003"), late.booking.id);
    now = ny(TUE, "19:30"); // faltan 90 min, el plazo es 120
    expect(await svc.cancelBooking(ctxA("+1003"), late.booking.id)).toEqual({
      ok: false,
      reason: "too_late",
      cutoffMinutes: 120,
    });
  });

  it("lista solo las reservas próximas del cliente", async () => {
    const h = await hold(ctxA(), "20:00");
    if (!h.ok) throw new Error("hold falló");
    await svc.confirmBooking(ctxA(), h.booking.id);
    await hold(ctxA("+1999"), "21:00");
    const mine = await svc.listMyBookings(ctxA());
    expect(mine.map((b) => [b.time, b.status])).toEqual([["20:00", "confirmed"]]);
  });
});

describe("aislamiento entre tenants (RLS)", () => {
  it("un tenant no ve servicios ni reservas de otro", async () => {
    const h = await hold(ctxA(), "20:00");
    if (!h.ok) throw new Error("hold falló");

    const servicesB = await svc.listServices(ctxB());
    expect(servicesB.map((s) => s.name)).toEqual(["Corte de pelo"]);

    // mismo teléfono, otro negocio: la reserva de A no existe para B
    expect(await svc.confirmBooking(ctxB(), h.booking.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await svc.listMyBookings({ ...ctxB(), locationId: IDS.locA })).toEqual([]);
  });

  it("aunque el código pida datos de otra sucursal, la base no los devuelve", async () => {
    const leaked = { ...ctxB(), locationId: IDS.locA }; // tenant B apuntando a la sucursal de A
    const r = await handleBookingTool(svc, leaked, "check_availability", {
      service_id: IDS.cena,
      date: TUE,
      party_size: 2,
    });
    expect(r).toMatchObject({ error: "location_not_found" });
  });

  it("resolve_wa_location identifica el negocio desde el webhook", async () => {
    const { rows } = await app.query("SELECT * FROM resolve_wa_location('wa-222')");
    expect(rows[0]).toMatchObject({ tenant_id: IDS.tenantB, location_id: IDS.locB });
  });
});

describe("tools del agente (flujo completo)", () => {
  it("consultar → apartar → confirmar, como lo haría el LLM", async () => {
    const ctx = ctxA("+56912345678", CONV2);

    const services: any = await handleBookingTool(svc, ctx, "list_services", {});
    const serviceId = services.services[0].service_id;

    const avail: any = await handleBookingTool(svc, ctx, "check_availability", {
      service_id: serviceId,
      date: TUE,
      party_size: 2,
      preferred_time: "21:00",
    });
    expect(avail.options.map((o: any) => o.time)).toContain("21:00");

    const held: any = await handleBookingTool(svc, ctx, "hold_slot", {
      service_id: serviceId,
      date: TUE,
      time: "21:00",
      party_size: 2,
      customer_name: "Rafael",
      notes: "cumpleaños",
    });
    expect(held).toMatchObject({ held: true, summary: { time: "21:00", party_size: 2, with: "Mesa 1" } });

    const confirmed: any = await handleBookingTool(svc, ctx, "confirm_booking", { booking_id: held.booking_id });
    expect(confirmed).toMatchObject({ confirmed: true, status: "confirmed" });

    const mine: any = await handleBookingTool(svc, ctx, "list_my_bookings", {});
    expect(mine.bookings).toHaveLength(1);
  });

  it("devuelve errores corregibles en vez de lanzar", async () => {
    const r = await handleBookingTool(svc, ctxA(), "check_availability", {
      service_id: IDS.cena,
      date: "13/10/2026",
      party_size: 2,
    });
    expect(r).toMatchObject({ error: "invalid_input" });
    expect(await handleBookingTool(svc, ctxA(), "confirm_booking", { booking_id: "abc" })).toEqual({
      confirmed: false,
      reason: "not_found",
    });
  });

  it("sin disponibilidad explica el motivo", async () => {
    const r = await handleBookingTool(svc, ctxA(), "check_availability", {
      service_id: IDS.cena,
      date: TUE,
      party_size: 9,
    });
    expect(r).toEqual({ date: TUE, options: [], reason: "party_too_large" });
  });
});

describe("reprogramar", () => {
  async function confirmed(ctx: ConversationContext, time: string, party = 3) {
    const h = await hold(ctx, time, party);
    if (!h.ok) throw new Error("hold falló");
    await svc.confirmBooking(ctx, h.booking.id);
    return h.booking.id;
  }

  it("mueve la reserva aunque el nuevo horario se solape con el viejo en la misma mesa", async () => {
    const id = await confirmed(ctxA(), "20:00"); // Mesa 2, 20:00–22:00 con buffer
    const r = await svc.rescheduleBooking(ctxA(), id, { date: TUE, time: "20:30" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.booking).toMatchObject({ time: "20:30", status: "confirmed", resourceNames: ["Mesa 2"] });

    const { rows } = await admin.query("SELECT status FROM bookings WHERE id = $1", [id]);
    expect(rows[0].status).toBe("cancelled");
    const events = await admin.query("SELECT event FROM booking_events WHERE booking_id = $1 ORDER BY id", [id]);
    expect(events.rows.map((e) => e.event)).toContain("rescheduled");
  });

  it("si el nuevo horario está ocupado, la reserva original queda intacta", async () => {
    const id = await confirmed(ctxA("+1001"), "18:00");
    await confirmed(ctxA("+1002"), "21:00");
    const r = await svc.rescheduleBooking(ctxA("+1001"), id, { date: TUE, time: "21:00" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("slot_unavailable");
      expect(r.alternatives.length).toBeGreaterThan(0);
    }
    const { rows } = await admin.query(
      `SELECT b.status, br.is_active FROM bookings b JOIN booking_resources br ON br.booking_id = b.id WHERE b.id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ status: "confirmed", is_active: true });
  });

  it("respeta el plazo de cambios", async () => {
    const id = await confirmed(ctxA(), "20:00");
    now = ny(TUE, "19:00");
    const r = await svc.rescheduleBooking(ctxA(), id, { date: TUE, time: "21:00" });
    expect(r).toMatchObject({ ok: false, reason: "too_late", cutoffMinutes: 120 });
  });

  it("vía tool, otro cliente no puede mover la reserva", async () => {
    const id = await confirmed(ctxA("+1001"), "20:00");
    const r = await handleBookingTool(svc, ctxA("+1999"), "reschedule_booking", {
      booking_id: id,
      date: TUE,
      time: "21:00",
    });
    expect(r).toMatchObject({ rescheduled: false, reason: "not_found" });
  });
});
