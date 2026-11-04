import { z } from "zod";
import { Id, LocalDate, LocalTime } from "./common.js";

// ---------- Reservas hechas o cambiadas por el equipo (consola) ----------

const Notes = z.string().trim().max(500);

/** Cliente existente (por id) o nuevo: nombre y al menos teléfono o email. */
export const BookingCustomerInput = z.union([
  z.object({ id: Id }).strict(),
  z
    .object({
      name: z.string().trim().min(1, "Escribe el nombre").max(120),
      phone: z.string().trim().max(30).nullish(),
      email: z.string().trim().max(200).nullish(),
    })
    .strict()
    .refine((c) => !!c.phone || !!c.email, { message: "Indica teléfono o email", path: ["phone"] }),
]);
export type BookingCustomerInput = z.infer<typeof BookingCustomerInput>;

/** POST /api/merchant/bookings */
export const ManualBookingCreate = z
  .object({
    serviceId: Id,
    date: LocalDate,
    time: LocalTime,
    /** null: el primer profesional libre que haga el servicio */
    staffId: Id.nullish(),
    customer: BookingCustomerInput,
    notes: Notes.nullish(),
    /** a propósito fuera del horario (nunca encima de otra reserva) */
    outsideHours: z.boolean().default(false),
  })
  .strict();
export type ManualBookingCreate = z.infer<typeof ManualBookingCreate>;

/** POST /api/merchant/bookings/:id/reschedule */
export const StaffReschedule = z
  .object({ date: LocalDate, time: LocalTime, staffId: Id.nullish(), outsideHours: z.boolean().default(false) })
  .strict();
export type StaffReschedule = z.infer<typeof StaffReschedule>;

/** POST /api/merchant/bookings/:id/cancel */
export const StaffCancel = z.object({ reason: z.string().trim().max(300).nullish() }).strict();
export type StaffCancel = z.infer<typeof StaffCancel>;

/** POST /api/merchant/bookings/:id/status (desde la hora de inicio) */
export const StaffStatus = z.object({ status: z.enum(["completed", "no_show"]) }).strict();
export type StaffStatus = z.infer<typeof StaffStatus>;

/** Querystring: GET /api/merchant/availability?serviceId=…&date=…&staffId=…&bookingId=… */
export const StaffAvailabilityQuery = z
  .object({
    serviceId: Id,
    date: LocalDate,
    staffId: Id.optional(),
    /** al mover una reserva: su horario actual cuenta como libre */
    bookingId: Id.optional(),
  })
  .strict();
export type StaffAvailabilityQuery = z.infer<typeof StaffAvailabilityQuery>;

export const StaffAvailability = z.object({
  /** horas libres y quién puede atender en cada una */
  times: z.array(z.object({ time: LocalTime, staffIds: z.array(Id) })),
});
export type StaffAvailability = z.infer<typeof StaffAvailability>;
