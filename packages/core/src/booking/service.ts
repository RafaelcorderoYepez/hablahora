import { DateTime } from "luxon";
import type { CountryCode } from "@hablahora/contracts";
import {
  expireStaleHoldsAt,
  getBusy,
  getExceptions,
  getLocationTimezone,
  getPolicy,
  getResources,
  getRules,
  getService,
  listServices,
  serviceDayRange,
  findVerifiedCustomer,
  upsertVerifiedCustomer,
  type FullPolicy,
  type ServiceRow,
} from "../db/repository.js";
import { isExclusionViolation, savepoint, withTenant, type Db, type Tx } from "../db/tenant.js";
import { findAvailableSlots, serviceDurationMin } from "../slots.js";
import type { NoSlotsReason, Slot, SlotQuery } from "../types.js";

/**
 * Lo que identifica la conversación. Lo arma el adaptador del canal
 * (tenant por phone_number_id o por el slug del chat web; cliente por el
 * número que escribe o por la conversación); el LLM nunca lo provee, así
 * no puede leer ni tocar datos ajenos.
 */
export interface ConversationContext {
  tenantId: string;
  locationId: string;
  conversationId?: string;
  channel: "whatsapp" | "voice" | "web" | "staff";
  /** cliente ya asociado a la conversación (en la web, tras save_customer_contact) */
  customerId?: string | null;
  /** teléfono E.164 probado por el canal (WhatsApp): identifica al cliente */
  verifiedPhone?: string;
  /** chat web: email probado con un código; da acceso a las reservas de ese email */
  verifiedEmail?: string | null;
  /** canal "staff": el usuario de la consola que hizo el cambio (queda en booking_events.actor) */
  actorUserId?: string;
}

/** Quién opera desde la consola: negocio, sucursal y usuario. */
export interface StaffContext {
  tenantId: string;
  locationId: string;
  userId: string;
}

/** Reserva creada por el negocio (consola). */
export interface ManualBookingInput {
  serviceId: string;
  date: string;
  time: string;
  /** null o ausente: el primer profesional libre que haga el servicio */
  staffId?: string | null;
  customer: { id: string } | { name: string; phone?: string | null; email?: string | null };
  notes?: string | null;
  /** el equipo la pone a propósito fuera del horario (nunca encima de otra reserva) */
  outsideHours?: boolean;
}

export type StaffActionFailure =
  | "not_found"
  | "not_allowed"
  | "slot_unavailable"
  | "slot_taken"
  | "in_past"
  | "staff_not_found"
  | "invalid_customer";

/** Para avisarle al cliente por email (si tiene) en su idioma. */
export interface CustomerNotice {
  email: string | null;
  name: string | null;
  locale: "es" | "en";
  business: string;
}

export type StaffActionResult =
  | { ok: true; booking: BookingView; notice: CustomerNotice }
  | { ok: false; reason: StaffActionFailure };

export interface OfferedSlot {
  date: string; // YYYY-MM-DD local
  time: string; // HH:mm local
  startsAt: string; // ISO UTC
  resourceName: string;
}

export interface BookingView {
  id: string;
  status: string;
  serviceName: string;
  date: string;
  time: string;
  partySize: number;
  resourceNames: string[];
  holdExpiresAt?: string;
}

export type HoldResult =
  | { ok: true; booking: BookingView }
  | {
      ok: false;
      reason: NoSlotsReason | "slot_unavailable" | "slot_taken" | "customer_contact_required";
      alternatives: OfferedSlot[];
      /** con customer_contact_required: qué datos faltan */
      missing?: ContactField[];
    };

export type ContactField = "name" | "phone" | "email";

export type SaveContactResult =
  | { ok: true; customerId: string; contact: { name: string | null; phone: string | null; email: string | null } }
  | { ok: false; reason: "not_available" | "contact_required" | "invalid_phone" | "invalid_email" };

export type ConfirmResult =
  | { ok: true; booking: BookingView }
  | { ok: false; reason: "not_found" | "hold_expired" | "not_a_hold" };

export type CancelResult =
  | { ok: true; booking: BookingView }
  | { ok: false; reason: "not_found" | "already_closed" | "too_late"; cutoffMinutes?: number };

type RescheduleFailure = NoSlotsReason | "slot_unavailable" | "slot_taken";

export type RescheduleResult =
  | { ok: true; booking: BookingView; previousBookingId: string }
  | {
      ok: false;
      reason: RescheduleFailure | "not_found" | "not_reschedulable" | "too_late";
      alternatives: OfferedSlot[];
      cutoffMinutes?: number;
    };

export class BookingError extends Error {
  constructor(
    public code: "service_not_found" | "location_not_found" | "invalid_input",
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AvailabilityInput {
  serviceId: string;
  date: string;
  partySize: number;
  preferredTime?: string;
  preferredResourceId?: string;
  maxResults?: number;
}

export interface ContactInput {
  name?: string;
  phone?: string;
  email?: string;
}

export interface HoldInput {
  serviceId: string;
  date: string;
  time: string;
  partySize: number;
  customerName?: string;
  notes?: string;
  preferredResourceId?: string;
}

export class BookingService {
  constructor(
    private db: Db,
    private clock: () => Date = () => new Date(),
  ) {}

  async listServices(ctx: ConversationContext): Promise<ServiceRow[]> {
    return withTenant(this.db, ctx.tenantId, (tx) => listServices(tx, ctx.locationId));
  }

  async checkAvailability(ctx: ConversationContext, input: AvailabilityInput) {
    validateDate(input.date);
    if (input.preferredTime) validateTime(input.preferredTime);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = this.clock();
      const loaded = await this.load(tx, ctx.locationId, input.serviceId, input.date, now);
      const result = findAvailableSlots({
        ...loaded.query,
        partySize: input.partySize,
        preferredTime: input.preferredTime,
        preferredResourceId: input.preferredResourceId,
        maxResults: input.maxResults ?? 4,
      });
      return {
        timezone: loaded.query.timezone,
        slots: result.slots.map((s) => offer(s, loaded)),
        reason: result.reason,
      };
    });
  }

  /**
   * Reserva temporal mientras el cliente confirma en el chat.
   * Revalida el horario dentro de la transacción y, si otro cliente ganó
   * el recurso en el intervalo, prueba con el siguiente recurso libre.
   */
  async holdSlot(ctx: ConversationContext, input: HoldInput): Promise<HoldResult> {
    validateDate(input.date);
    validateTime(input.time);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = this.clock();
      await expireStaleHoldsAt(tx, ctx.locationId, now);
      const customerId = await resolveCustomer(tx, ctx, { create: true, name: input.customerName });
      if (!customerId) {
        return { ok: false, reason: "customer_contact_required", alternatives: [], missing: ["name", "phone", "email"] };
      }
      // en la web se reserva con nombre, teléfono y email (en WhatsApp el teléfono lo da el canal)
      if (ctx.channel === "web") {
        const missing = await missingContact(tx, customerId);
        if (missing.length) return { ok: false, reason: "customer_contact_required", alternatives: [], missing };
      }

      // si el cliente cambia de idea en la misma conversación, suelta el hold anterior
      if (ctx.conversationId) {
        await releaseConversationHolds(tx, customerId, ctx.conversationId, now);
      }

      const loaded = await this.load(tx, ctx.locationId, input.serviceId, input.date, now);
      const tz = loaded.query.timezone;
      const target = DateTime.fromISO(`${input.date}T${input.time}`, { zone: tz }).toMillis();
      const baseQuery: SlotQuery = {
        ...loaded.query,
        partySize: input.partySize,
        preferredResourceId: input.preferredResourceId,
      };

      const result = findAvailableSlots(baseQuery);
      const slot = result.slots.find((s) => s.start.getTime() === target);
      if (!slot) {
        return {
          ok: false,
          reason: result.reason ?? "slot_unavailable",
          alternatives: nearest(result.slots, target, 3).map((s) => offer(s, loaded)),
        };
      }

      const expiresAt = new Date(now.getTime() + loaded.policy.holdTtlSec * 1000);
      for (const resourceId of slot.candidateResourceIds) {
        try {
          const bookingId = await savepoint(tx, () =>
            insertHold(tx, {
              ctx,
              customerId,
              serviceId: input.serviceId,
              slot,
              resourceId,
              bufferMin: loaded.service.bufferAfterMin,
              partySize: input.partySize,
              notes: input.notes,
              expiresAt,
            }),
          );
          return {
            ok: true,
            booking: {
              id: bookingId,
              status: "hold",
              serviceName: loaded.service.name,
              date: input.date,
              time: slot.localTime,
              partySize: input.partySize,
              resourceNames: [loaded.resourceNames.get(resourceId)!],
              holdExpiresAt: expiresAt.toISOString(),
            },
          };
        } catch (err) {
          if (!isExclusionViolation(err)) throw err;
          // otro cliente tomó este recurso en el intervalo: probar el siguiente
        }
      }

      // todos los recursos se ocuparon mientras tanto: recalcular con datos frescos
      const fresh = findAvailableSlots({
        ...baseQuery,
        busy: await getBusy(tx, ctx.locationId, serviceDayRange(input.date, tz), now),
      });
      return {
        ok: false,
        reason: "slot_taken",
        alternatives: nearest(fresh.slots, target, 3).map((s) => offer(s, loaded)),
      };
    });
  }

  async confirmBooking(ctx: ConversationContext, bookingId: string): Promise<ConfirmResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found" };
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = this.clock();
      const b = await lockOwnBooking(tx, bookingId, await ownedCustomerIds(tx, ctx));
      if (!b) return { ok: false, reason: "not_found" };
      if (b.status !== "hold") return { ok: false, reason: "not_a_hold" };
      if (b.hold_expires_at < now) {
        await setStatus(tx, ctx, b.id, "expired", now);
        return { ok: false, reason: "hold_expired" };
      }
      const policy = await getPolicy(tx, b.location_id, b.service_id);
      const status = policy.autoConfirm ? "confirmed" : "pending";
      await tx.query(
        "UPDATE bookings SET status = $2, hold_expires_at = NULL, updated_at = $3 WHERE id = $1",
        [b.id, status, now],
      );
      await logEvent(tx, ctx, b.id, status === "confirmed" ? "confirmed" : "requested");
      return { ok: true, booking: await this.view(tx, b.id) };
    });
  }

  async cancelBooking(ctx: ConversationContext, bookingId: string): Promise<CancelResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found" };
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = this.clock();
      const b = await lockOwnBooking(tx, bookingId, await ownedCustomerIds(tx, ctx));
      if (!b) return { ok: false, reason: "not_found" };
      if (!["hold", "pending", "confirmed"].includes(b.status)) {
        return { ok: false, reason: "already_closed" };
      }
      if (b.status !== "hold") {
        const policy = await getPolicy(tx, b.location_id, b.service_id);
        const cutoff = b.starts_at.getTime() - policy.cancelCutoffMin * 60_000;
        if (now.getTime() > cutoff) {
          return { ok: false, reason: "too_late", cutoffMinutes: policy.cancelCutoffMin };
        }
      }
      await setStatus(tx, ctx, b.id, "cancelled", now);
      return { ok: true, booking: await this.view(tx, b.id) };
    });
  }

  /**
   * Mueve una reserva confirmada o pendiente a otro horario, de forma atómica:
   * o queda la nueva y se cancela la anterior, o no cambia nada.
   * El agente debe haber acordado el nuevo horario con el cliente antes de llamarlo.
   */
  async rescheduleBooking(
    ctx: ConversationContext,
    bookingId: string,
    input: { date: string; time: string; partySize?: number },
  ): Promise<RescheduleResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found", alternatives: [] };
    validateDate(input.date);
    validateTime(input.time);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = this.clock();
      const old = await lockOwnBooking(tx, bookingId, await ownedCustomerIds(tx, ctx));
      if (!old) return { ok: false, reason: "not_found", alternatives: [] };
      if (!["pending", "confirmed"].includes(old.status)) {
        return { ok: false, reason: "not_reschedulable", alternatives: [] };
      }
      const policy = await getPolicy(tx, old.location_id, old.service_id);
      if (now.getTime() > old.starts_at.getTime() - policy.cancelCutoffMin * 60_000) {
        return { ok: false, reason: "too_late", alternatives: [], cutoffMinutes: policy.cancelCutoffMin };
      }
      await expireStaleHoldsAt(tx, old.location_id, now);

      const partySize: number = input.partySize ?? old.party_size;
      // se libera la mesa actual para que el nuevo horario pueda solaparse con el viejo
      await tx.query("SAVEPOINT reschedule");
      await tx.query("UPDATE booking_resources SET is_active = false WHERE booking_id = $1", [old.id]);

      const loaded = await this.load(tx, old.location_id, old.service_id, input.date, now);
      const target = DateTime.fromISO(`${input.date}T${input.time}`, { zone: loaded.query.timezone }).toMillis();
      const result = findAvailableSlots({ ...loaded.query, partySize });
      const slot = result.slots.find((s) => s.start.getTime() === target);

      const giveUp = async (reason: RescheduleFailure) => {
        await tx.query("ROLLBACK TO SAVEPOINT reschedule"); // la reserva original queda intacta
        return {
          ok: false as const,
          reason,
          alternatives: nearest(result.slots, target, 3).map((s) => offer(s, loaded)),
        };
      };
      if (!slot) return giveUp(result.reason ?? "slot_unavailable");

      for (const resourceId of slot.candidateResourceIds) {
        try {
          const newId = await savepoint(tx, async () => {
            const id = await insertHold(tx, {
              ctx,
              customerId: old.customer_id,
              serviceId: old.service_id,
              slot,
              resourceId,
              bufferMin: loaded.service.bufferAfterMin,
              partySize,
              notes: old.notes ?? undefined,
              expiresAt: now,
            });
            await tx.query(
              "UPDATE bookings SET status = $2, hold_expires_at = NULL, external_ref = $3 WHERE id = $1",
              [id, old.status, old.external_ref],
            );
            return id;
          });
          await tx.query("UPDATE bookings SET status = 'cancelled', updated_at = $2 WHERE id = $1", [old.id, now]);
          await logEvent(tx, ctx, old.id, "rescheduled", { new_booking_id: newId });
          await logEvent(tx, ctx, newId, "rescheduled_from", { old_booking_id: old.id });
          return { ok: true, booking: await this.view(tx, newId), previousBookingId: old.id };
        } catch (err) {
          if (!isExclusionViolation(err)) throw err;
        }
      }
      return giveUp("slot_taken");
    });
  }

  async listMyBookings(ctx: ConversationContext): Promise<BookingView[]> {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = this.clock();
      const customerIds = await ownedCustomerIds(tx, ctx);
      if (!customerIds.length) return [];
      const { rows } = await tx.query(
        `SELECT b.id FROM bookings b
          WHERE b.customer_id = ANY($1) AND b.location_id = $2 AND b.ends_at >= $3
            AND (b.status IN ('pending','confirmed')
                 OR (b.status = 'hold' AND b.hold_expires_at >= $3))
          ORDER BY b.starts_at`,
        [customerIds, ctx.locationId, now],
      );
      const out: BookingView[] = [];
      for (const r of rows) out.push(await this.view(tx, r.id));
      return out;
    });
  }

  /**
   * Guarda el contacto que el cliente escribió en el chat web y lo asocia a la
   * conversación. Queda sin verificar: no se fusiona con otros clientes, así que
   * desde esta conversación solo se ven las reservas hechas en ella.
   */
  async saveCustomerContact(ctx: ConversationContext, input: ContactInput): Promise<SaveContactResult> {
    if (ctx.channel !== "web" || !ctx.conversationId) return { ok: false, reason: "not_available" };

    return withTenant(this.db, ctx.tenantId, async (tx) => {
      // un teléfono sin prefijo se completa con el del país del negocio
      const phone = input.phone?.trim() ? normalizePhone(input.phone, await tenantCountry(tx, ctx.tenantId)) : null;
      if (input.phone?.trim() && !phone) return { ok: false, reason: "invalid_phone" };
      const email = input.email?.trim() ? normalizeEmail(input.email) : null;
      if (input.email?.trim() && !email) return { ok: false, reason: "invalid_email" };
      const name = input.name?.trim() || null;

      let row;
      if (ctx.customerId) {
        ({ rows: [row] } = await tx.query(
          `UPDATE customers
              SET phone_e164 = coalesce($2, phone_e164), email = coalesce($3, email), name = coalesce($4, name)
            WHERE id = $1
            RETURNING id, name, phone_e164, email`,
          [ctx.customerId, phone, email, name],
        ));
      } else {
        if (!phone && !email) return { ok: false, reason: "contact_required" };
        ({ rows: [row] } = await tx.query(
          `INSERT INTO customers (tenant_id, phone_e164, email, name)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, phone_e164, email`,
          [ctx.tenantId, phone, email, name],
        ));
        await tx.query("UPDATE conversations SET customer_id = $2 WHERE id = $1", [ctx.conversationId, row.id]);
      }
      return {
        ok: true,
        customerId: row.id,
        contact: { name: row.name, phone: row.phone_e164, email: row.email },
      };
    });
  }

  // -------------------------------------------------------------------
  // Acciones del equipo (consola). Sin los límites del cliente (anticipación,
  // plazo para cancelar), pero la doble reserva sigue siendo imposible.
  // -------------------------------------------------------------------

  /** Reserva creada por el negocio: queda confirmada. */
  async staffCreateBooking(s: StaffContext, input: ManualBookingInput): Promise<StaffActionResult> {
    validateDate(input.date);
    validateTime(input.time);
    const ctx = staffCtx(s);
    return withTenant(this.db, s.tenantId, async (tx) => {
      const now = this.clock();
      await expireStaleHoldsAt(tx, s.locationId, now);
      const customerId = await staffCustomer(tx, s.tenantId, input.customer);
      if (!customerId) return { ok: false, reason: "invalid_customer" };

      const loaded = await this.load(tx, s.locationId, input.serviceId, input.date, now);
      const placed = this.placeForStaff(loaded, input, now);
      if (!placed.ok) return placed;

      for (const resourceId of placed.candidates) {
        try {
          const id = await savepoint(tx, async () => {
            const bookingId = await insertHold(tx, {
              ctx,
              customerId,
              serviceId: input.serviceId,
              slot: placed.slot,
              resourceId,
              bufferMin: loaded.service.bufferAfterMin,
              partySize: 1,
              notes: input.notes ?? undefined,
              expiresAt: now,
            });
            await tx.query("UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1", [bookingId]);
            await logEvent(tx, ctx, bookingId, "confirmed", { outside_hours: !!input.outsideHours });
            return bookingId;
          });
          return { ok: true, booking: await this.view(tx, id), notice: await customerNotice(tx, id) };
        } catch (err) {
          if (!isExclusionViolation(err)) throw err;
        }
      }
      return { ok: false, reason: "slot_taken" };
    });
  }

  /** Confirma una reserva pendiente (o un apartado vigente). */
  async staffConfirm(s: StaffContext, bookingId: string): Promise<StaffActionResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found" };
    const ctx = staffCtx(s);
    return withTenant(this.db, s.tenantId, async (tx) => {
      const now = this.clock();
      const b = await lockForStaff(tx, bookingId, s.locationId);
      if (!b) return { ok: false, reason: "not_found" };
      const liveHold = b.status === "hold" && b.hold_expires_at >= now;
      if (b.status !== "pending" && !liveHold) return { ok: false, reason: "not_allowed" };
      await tx.query("UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = $2 WHERE id = $1", [
        b.id,
        now,
      ]);
      await logEvent(tx, ctx, b.id, "confirmed");
      return { ok: true, booking: await this.view(tx, b.id), notice: await customerNotice(tx, b.id) };
    });
  }

  /** Cancela aunque haya pasado el plazo del cliente. */
  async staffCancel(s: StaffContext, bookingId: string, reason?: string | null): Promise<StaffActionResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found" };
    const ctx = staffCtx(s);
    return withTenant(this.db, s.tenantId, async (tx) => {
      const now = this.clock();
      const b = await lockForStaff(tx, bookingId, s.locationId);
      if (!b) return { ok: false, reason: "not_found" };
      if (!["hold", "pending", "confirmed"].includes(b.status)) return { ok: false, reason: "not_allowed" };
      await tx.query("UPDATE bookings SET status = 'cancelled', updated_at = $2 WHERE id = $1", [b.id, now]);
      await tx.query("UPDATE booking_resources SET is_active = false WHERE booking_id = $1", [b.id]);
      await logEvent(tx, ctx, b.id, "cancelled", reason ? { reason } : {});
      return { ok: true, booking: await this.view(tx, b.id), notice: await customerNotice(tx, b.id) };
    });
  }

  /** Atendida o no vino: solo desde la hora de inicio. */
  async staffSetStatus(s: StaffContext, bookingId: string, status: "completed" | "no_show"): Promise<StaffActionResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found" };
    const ctx = staffCtx(s);
    return withTenant(this.db, s.tenantId, async (tx) => {
      const now = this.clock();
      const b = await lockForStaff(tx, bookingId, s.locationId);
      if (!b) return { ok: false, reason: "not_found" };
      if (!["pending", "confirmed", "completed", "no_show"].includes(b.status) || b.starts_at > now) {
        return { ok: false, reason: "not_allowed" };
      }
      await tx.query("UPDATE bookings SET status = $2, updated_at = $3 WHERE id = $1", [b.id, status, now]);
      await logEvent(tx, ctx, b.id, status);
      return { ok: true, booking: await this.view(tx, b.id), notice: await customerNotice(tx, b.id) };
    });
  }

  /**
   * Mueve una reserva a otro horario y/o profesional, en un solo paso:
   * o queda la nueva y se cancela la anterior, o no cambia nada.
   */
  async staffReschedule(
    s: StaffContext,
    bookingId: string,
    input: { date: string; time: string; staffId?: string | null; outsideHours?: boolean },
  ): Promise<StaffActionResult> {
    if (!UUID.test(bookingId)) return { ok: false, reason: "not_found" };
    validateDate(input.date);
    validateTime(input.time);
    const ctx = staffCtx(s);
    return withTenant(this.db, s.tenantId, async (tx) => {
      const now = this.clock();
      const old = await lockForStaff(tx, bookingId, s.locationId);
      if (!old) return { ok: false, reason: "not_found" };
      if (!["pending", "confirmed"].includes(old.status)) return { ok: false, reason: "not_allowed" };
      await expireStaleHoldsAt(tx, s.locationId, now);

      // se libera el horario actual para que el nuevo pueda solaparse con el viejo
      await tx.query("SAVEPOINT staff_move");
      await tx.query("UPDATE booking_resources SET is_active = false WHERE booking_id = $1", [old.id]);
      const giveUp = async (reason: StaffActionFailure) => {
        await tx.query("ROLLBACK TO SAVEPOINT staff_move"); // la reserva original queda intacta
        return { ok: false as const, reason };
      };
      const loaded = await this.load(tx, s.locationId, old.service_id, input.date, now);
      const placed = this.placeForStaff(loaded, input, now);
      if (!placed.ok) return giveUp(placed.reason);

      for (const resourceId of placed.candidates) {
        try {
          const newId = await savepoint(tx, async () => {
            const id = await insertHold(tx, {
              ctx,
              customerId: old.customer_id,
              serviceId: old.service_id,
              slot: placed.slot,
              resourceId,
              bufferMin: loaded.service.bufferAfterMin,
              partySize: old.party_size,
              notes: old.notes ?? undefined,
              expiresAt: now,
            });
            await tx.query(
              "UPDATE bookings SET status = $2, hold_expires_at = NULL, external_ref = $3, conversation_id = $4 WHERE id = $1",
              [id, old.status, old.external_ref, old.conversation_id],
            );
            return id;
          });
          await tx.query("UPDATE bookings SET status = 'cancelled', updated_at = $2 WHERE id = $1", [old.id, now]);
          await logEvent(tx, ctx, old.id, "rescheduled", { new_booking_id: newId });
          await logEvent(tx, ctx, newId, "rescheduled_from", { old_booking_id: old.id, outside_hours: !!input.outsideHours });
          return { ok: true, booking: await this.view(tx, newId), notice: await customerNotice(tx, newId) };
        } catch (err) {
          if (!isExclusionViolation(err)) throw err;
        }
      }
      return giveUp("slot_taken");
    });
  }

  /**
   * Horarios libres para el equipo (sin anticipación mínima ni límite de días).
   * Al mover una reserva, su propio horario cuenta como libre.
   */
  async staffAvailability(
    s: StaffContext,
    input: { serviceId: string; date: string; staffId?: string | null; excludeBookingId?: string | null },
  ): Promise<{ times: { time: string; staffIds: string[] }[] }> {
    validateDate(input.date);
    return withTenant(this.db, s.tenantId, async (tx) => {
      const now = this.clock();
      await tx.query("SAVEPOINT staff_availability");
      try {
        if (input.excludeBookingId && UUID.test(input.excludeBookingId)) {
          await tx.query("UPDATE booking_resources SET is_active = false WHERE booking_id = $1 AND tenant_id = $2", [
            input.excludeBookingId,
            s.tenantId,
          ]);
        }
        const loaded = await this.load(tx, s.locationId, input.serviceId, input.date, now);
        const result = findAvailableSlots({
          ...loaded.query,
          partySize: 1,
          policy: { ...loaded.query.policy, minLeadTimeMin: 0, maxAdvanceDays: 3650 },
        });
        const times = result.slots
          .map((x) => ({ time: x.localTime, staffIds: x.candidateResourceIds }))
          .filter((x) => !input.staffId || x.staffIds.includes(input.staffId));
        return { times };
      } finally {
        await tx.query("ROLLBACK TO SAVEPOINT staff_availability"); // solo se leyó
      }
    });
  }

  /**
   * Dónde cabe una reserva del equipo: dentro del horario (sin anticipación
   * mínima ni límite de días) o, si lo marcó, fuera de horario. Nunca en el pasado.
   */
  private placeForStaff(
    loaded: Awaited<ReturnType<BookingService["load"]>>,
    input: { date: string; time: string; staffId?: string | null; outsideHours?: boolean },
    now: Date,
  ): { ok: true; slot: Slot; candidates: string[] } | { ok: false; reason: StaffActionFailure } {
    const tz = loaded.query.timezone;
    const target = DateTime.fromISO(`${input.date}T${input.time}`, { zone: tz }).toMillis();
    if (target < now.getTime()) return { ok: false, reason: "in_past" };
    const doers = loaded.query.resources.filter((r) => r.isActive && loaded.service.resourceIds.includes(r.id));
    if (input.staffId && !doers.some((r) => r.id === input.staffId)) return { ok: false, reason: "staff_not_found" };

    if (input.outsideHours) {
      const end = target + serviceDurationMin(loaded.service, 1) * 60_000;
      const candidates = input.staffId ? [input.staffId] : doers.map((r) => r.id);
      if (!candidates.length) return { ok: false, reason: "staff_not_found" };
      const slot: Slot = {
        start: new Date(target),
        end: new Date(end),
        localTime: input.time,
        resourceId: candidates[0],
        candidateResourceIds: candidates,
      };
      return { ok: true, slot, candidates };
    }

    const result = findAvailableSlots({
      ...loaded.query,
      partySize: 1,
      preferredResourceId: input.staffId ?? undefined,
      // el equipo puede reservar para ya mismo y para cuando quiera
      policy: { ...loaded.query.policy, minLeadTimeMin: 0, maxAdvanceDays: 3650 },
    });
    const slot = result.slots.find(
      (x) => x.start.getTime() === target && (!input.staffId || x.candidateResourceIds.includes(input.staffId)),
    );
    if (!slot) return { ok: false, reason: "slot_unavailable" };
    return { ok: true, slot, candidates: input.staffId ? [input.staffId] : slot.candidateResourceIds };
  }

  // -------------------------------------------------------------------

  private async load(
tx: Tx, locationId: string, serviceId: string, date: string, now: Date) {
    const timezone = await getLocationTimezone(tx, locationId);
    if (!timezone) throw new BookingError("location_not_found", "Sucursal no encontrada");
    if (!UUID.test(serviceId)) throw new BookingError("service_not_found", "Servicio no encontrado");
    const service = await getService(tx, locationId, serviceId);
    if (!service) throw new BookingError("service_not_found", "Servicio no encontrado");

    const range = serviceDayRange(date, timezone);
    // secuencial: una misma conexión no admite consultas en paralelo
    const policy = await getPolicy(tx, locationId, serviceId);
    const resources = await getResources(tx, locationId);
    const rules = await getRules(tx, locationId);
    const exceptions = await getExceptions(tx, locationId, range);
    const busy = await getBusy(tx, locationId, range, now);
    const query: Omit<SlotQuery, "partySize"> = {
      timezone,
      date,
      now,
      service,
      resources,
      rules,
      exceptions,
      busy,
      policy,
    };
    return {
      query,
      service,
      policy,
      resourceNames: new Map(resources.map((r) => [r.id, r.name])),
    };
  }

  private async view(tx: Tx, bookingId: string): Promise<BookingView> {
    const { rows } = await tx.query(
      `SELECT b.id, b.status, b.starts_at, b.party_size, b.hold_expires_at, s.name AS service_name,
              l.timezone,
              coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS resource_names
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN locations l ON l.id = b.location_id
         LEFT JOIN booking_resources br ON br.booking_id = b.id
         LEFT JOIN resources r ON r.id = br.resource_id
        WHERE b.id = $1
        GROUP BY b.id, s.name, l.timezone`,
      [bookingId],
    );
    const r = rows[0];
    const local = DateTime.fromJSDate(r.starts_at, { zone: r.timezone });
    return {
      id: r.id,
      status: r.status,
      serviceName: r.service_name,
      date: local.toISODate()!,
      time: local.toFormat("HH:mm"),
      partySize: r.party_size,
      resourceNames: r.resource_names,
      holdExpiresAt: r.hold_expires_at?.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------

type Loaded = { query: { timezone: string }; resourceNames: Map<string, string> };

function offer(s: Slot, loaded: Loaded): OfferedSlot {
  const local = DateTime.fromJSDate(s.start, { zone: loaded.query.timezone });
  return {
    date: local.toISODate()!,
    time: s.localTime,
    startsAt: s.start.toISOString(),
    resourceName: loaded.resourceNames.get(s.resourceId) ?? "",
  };
}

function nearest(slots: Slot[], target: number, n: number): Slot[] {
  return [...slots]
    .sort(
      (a, b) =>
        Math.abs(a.start.getTime() - target) - Math.abs(b.start.getTime() - target) ||
        a.start.getTime() - b.start.getTime(),
    )
    .slice(0, n)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function validateDate(d: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !DateTime.fromISO(d).isValid) {
    throw new BookingError("invalid_input", `Fecha inválida: ${d} (formato YYYY-MM-DD)`);
  }
}

function validateTime(t: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
    throw new BookingError("invalid_input", `Hora inválida: ${t} (formato HH:mm)`);
  }
}

async function insertHold(
  tx: Tx,
  a: {
    ctx: ConversationContext;
    customerId: string;
    serviceId: string;
    slot: Slot;
    resourceId: string;
    bufferMin: number;
    partySize: number;
    notes?: string;
    expiresAt: Date;
  },
): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO bookings (tenant_id, location_id, service_id, customer_id, starts_at, ends_at,
                           party_size, status, hold_expires_at, source, conversation_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'hold', $8, $9, $10, $11)
     RETURNING id`,
    [
      a.ctx.tenantId,
      a.ctx.locationId,
      a.serviceId,
      a.customerId,
      a.slot.start,
      a.slot.end,
      a.partySize,
      a.expiresAt,
      a.ctx.channel,
      a.ctx.conversationId ?? null,
      a.notes ?? null,
    ],
  );
  const bookingId: string = rows[0].id;
  const occupiedUntil = new Date(a.slot.end.getTime() + a.bufferMin * 60_000);
  await tx.query(
    `INSERT INTO booking_resources (booking_id, resource_id, tenant_id, period)
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'))`,
    [bookingId, a.resourceId, a.ctx.tenantId, a.slot.start, occupiedUntil],
  );
  await logEvent(tx, a.ctx, bookingId, "created", { status: "hold" });
  return bookingId;
}

async function releaseConversationHolds(tx: Tx, customerId: string, conversationId: string, now: Date) {
  const { rows } = await tx.query(
    `UPDATE bookings SET status = 'expired', updated_at = $3
      WHERE customer_id = $1 AND conversation_id = $2 AND status = 'hold'
      RETURNING id`,
    [customerId, conversationId, now],
  );
  if (rows.length) {
    await tx.query("UPDATE booking_resources SET is_active = false WHERE booking_id = ANY($1)", [
      rows.map((r) => r.id),
    ]);
  }
}

/**
 * Quién es el cliente de esta conversación:
 * 1. el que ya está asociado a la conversación;
 * 2. en WhatsApp, el del teléfono verificado (se crea al apartar y se asocia);
 * 3. si no, nadie: en la web el cliente aún no dejó su contacto.
 */
async function resolveCustomer(
  tx: Tx,
  ctx: ConversationContext,
  opts: { create: boolean; name?: string },
): Promise<string | null> {
  if (ctx.customerId) {
    if (opts.name) await tx.query("UPDATE customers SET name = $2 WHERE id = $1", [ctx.customerId, opts.name]);
    return ctx.customerId;
  }
  if (!ctx.verifiedPhone) return null;
  const id = opts.create
    ? await upsertVerifiedCustomer(tx, ctx.tenantId, ctx.verifiedPhone, ctx.channel, opts.name)
    : await findVerifiedCustomer(tx, ctx.verifiedPhone);
  if (id && ctx.conversationId) {
    await tx.query("UPDATE conversations SET customer_id = $2 WHERE id = $1 AND customer_id IS NULL", [
      ctx.conversationId,
      id,
    ]);
  }
  return id;
}

/**
 * Clientes cuyas reservas puede ver y tocar esta conversación: el suyo y,
 * si el cliente probó su email con un código, todos los del negocio con ese email.
 */
async function ownedCustomerIds(tx: Tx, ctx: ConversationContext): Promise<string[]> {
  const ids = new Set<string>();
  const own = await resolveCustomer(tx, ctx, { create: false });
  if (own) ids.add(own);
  if (ctx.verifiedEmail) {
    const { rows } = await tx.query("SELECT id FROM customers WHERE lower(email) = lower($1)", [ctx.verifiedEmail]);
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

async function missingContact(tx: Tx, customerId: string): Promise<ContactField[]> {
  const { rows } = await tx.query("SELECT name, phone_e164, email FROM customers WHERE id = $1", [customerId]);
  const c = rows[0] ?? {};
  const missing: ContactField[] = [];
  if (!c.name) missing.push("name");
  if (!c.phone_e164) missing.push("phone");
  if (!c.email) missing.push("email");
  return missing;
}

async function lockOwnBooking(tx: Tx, bookingId: string, customerIds: string[]) {
  if (!customerIds.length) return null;
  const { rows } = await tx.query("SELECT * FROM bookings WHERE id = $1 AND customer_id = ANY($2) FOR UPDATE", [
    bookingId,
    customerIds,
  ]);
  return rows[0] ?? null;
}

/**
 * Teléfono a E.164. Con "+", se acepta tal cual (de cualquier país). Sin prefijo, se completa
 * con el del país del negocio: Chile, 9 dígitos (+56 9 1234 5678) o con 56 adelante;
 * EE.UU., 10 dígitos o con 1 adelante.
 */
export function normalizePhone(raw: string, country: CountryCode): string | null {
  const s = raw.trim().replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  if (country === "CL") {
    if (/^\d{9}$/.test(s)) return `+56${s}`;
    if (/^56\d{9}$/.test(s)) return `+${s}`;
    return null;
  }
  if (/^\d{10}$/.test(s)) return `+1${s}`;
  if (/^1\d{10}$/.test(s)) return `+${s}`;
  return null;
}

async function tenantCountry(tx: Tx, tenantId: string): Promise<CountryCode> {
  const { rows } = await tx.query("SELECT country FROM tenants WHERE id = $1", [tenantId]);
  return rows[0].country;
}

export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

async function setStatus(
  tx: Tx,
  ctx: ConversationContext,
  bookingId: string,
  status: "cancelled" | "expired",
  now: Date,
) {
  await tx.query("UPDATE bookings SET status = $2, updated_at = $3 WHERE id = $1", [bookingId, status, now]);
  await tx.query("UPDATE booking_resources SET is_active = false WHERE booking_id = $1", [bookingId]);
  await logEvent(tx, ctx, bookingId, status);
}

async function logEvent(
  tx: Tx,
  ctx: ConversationContext,
  bookingId: string,
  event: string,
  payload: Record<string, unknown> = {},
) {
  await tx.query(
    `INSERT INTO booking_events (tenant_id, booking_id, event, actor, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      ctx.tenantId,
      bookingId,
      event,
      ctx.channel === "staff" ? (ctx.actorUserId ? `staff:${ctx.actorUserId}` : "staff") : "agent",
      { ...payload, channel: ctx.channel },
    ],
  );
}

// ---------------------------------------------------------------------
// Apoyo de las acciones del equipo
// ---------------------------------------------------------------------

function staffCtx(s: StaffContext): ConversationContext {
  return { tenantId: s.tenantId, locationId: s.locationId, channel: "staff", actorUserId: s.userId };
}

async function lockForStaff(tx: Tx, bookingId: string, locationId: string) {
  const { rows } = await tx.query("SELECT * FROM bookings WHERE id = $1 AND location_id = $2 FOR UPDATE", [bookingId, locationId]);
  return rows[0] ?? null;
}

/** Cliente existente (por id) o nuevo (nombre + teléfono y/o email válidos). */
async function staffCustomer(tx: Tx, tenantId: string, c: ManualBookingInput["customer"]): Promise<string | null> {
  if ("id" in c) {
    if (!UUID.test(c.id)) return null;
    const { rows } = await tx.query("SELECT id FROM customers WHERE id = $1", [c.id]);
    return rows[0]?.id ?? null;
  }
  const name = c.name?.trim();
  const phone = c.phone?.trim() ? normalizePhone(c.phone, await tenantCountry(tx, tenantId)) : null;
  const email = c.email?.trim() ? normalizeEmail(c.email) : null;
  if (!name || (c.phone?.trim() && !phone) || (c.email?.trim() && !email) || (!phone && !email)) return null;
  const { rows } = await tx.query("INSERT INTO customers (tenant_id, name, phone_e164, email) VALUES ($1, $2, $3, $4) RETURNING id", [
    tenantId,
    name,
    phone,
    email,
  ]);
  return rows[0].id;
}

/** Contacto e idioma del cliente de una reserva, para avisarle por email. */
async function customerNotice(tx: Tx, bookingId: string): Promise<CustomerNotice> {
  const { rows } = await tx.query(
    `SELECT c.email, c.name, t.name AS business, coalesce(cv.locale, l.default_locale) AS locale
       FROM bookings b
       JOIN locations l ON l.id = b.location_id
       JOIN tenants t ON t.id = b.tenant_id
       LEFT JOIN customers c ON c.id = b.customer_id
       LEFT JOIN conversations cv ON cv.id = b.conversation_id
      WHERE b.id = $1`,
    [bookingId],
  );
  const r = rows[0];
  return { email: r?.email ?? null, name: r?.name ?? null, locale: r?.locale === "en" ? "en" : "es", business: r?.business ?? "" };
}
