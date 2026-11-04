import { z } from "zod";

/** Hora local del negocio, 24 h: "09:00". */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:mm, 24 h)");

/** Fecha local del negocio: "2026-11-26". */
export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (YYYY-MM-DD)")
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
  }, "Fecha inválida");

export const Id = z.uuid();

/** 0 = domingo … 6 = sábado. */
export const Weekday = z.number().int().min(0).max(6);

/** Tramo semanal en hora local. Si end < start, cruza la medianoche (pertenece al día en que abre). */
export const ScheduleSlot = z
  .object({ weekday: Weekday, start: LocalTime, end: LocalTime })
  .refine((s) => s.start !== s.end, { message: "El tramo no puede empezar y terminar a la misma hora", path: ["end"] });
export type ScheduleSlot = z.infer<typeof ScheduleSlot>;

export const WeeklySchedule = z.array(ScheduleSlot).max(50);
export type WeeklySchedule = z.infer<typeof WeeklySchedule>;

export const TimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}, "Zona horaria inválida (p. ej. America/New_York)");

export const Locale = z.enum(["es", "en"]);

/** País del negocio (decide moneda, teléfonos y valores por defecto; ver COUNTRIES). */
export const Country = z.enum(["CL", "US"]);
export const Currency = z.enum(["CLP", "USD"]);

/** Caminos del dominio del chat que no pueden ser el enlace de un negocio. */
export const RESERVED_SLUGS = ["api", "assets", "privacidad", "privacy", "embed", "health", "favicon"] as const;

export const Slug = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Solo minúsculas, números y guiones (p. ej. salon-aurora)")
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), "Ese enlace está reservado. Elige otro.");

/** Contacto del cliente final. */
export const CustomerContact = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type CustomerContact = z.infer<typeof CustomerContact>;

/**
 * Motivo de un error de negocio (409/422), para que las consolas lo expliquen
 * en su idioma. `message` es un texto de respaldo en español.
 */
export const ErrorReason = z.enum([
  "slug_taken",
  "service_needs_staff",
  "staff_not_found",
  "service_not_found",
  "chat_not_ready",
  "not_found",
  "invalid_cursor",
  "no_location",
  // reservas desde la consola
  "slot_unavailable",
  "slot_taken",
  "in_past",
  "booking_not_allowed",
  "invalid_customer",
  // bandeja de paso a humano
  "not_in_handoff",
  "channel_not_supported",
  // plataforma
  "plan_limit_staff",
  "plan_name_taken",
  "plan_in_use",
  "plan_not_found",
  "business_suspended",
  "business_closed",
  "last_platform_admin",
  "user_exists",
  // logo del chat
  "logo_too_large",
  "logo_invalid",
]);
export type ErrorReason = z.infer<typeof ErrorReason>;

/** Error de la API: siempre esta forma. */
export const ApiError = z.object({
  error: z.string(),
  reason: ErrorReason.optional(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
