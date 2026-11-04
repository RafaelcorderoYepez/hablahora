import { z } from "zod";
import { ChatSettings } from "./chat.js";
import { Country, Currency, Id, LocalDate, Locale, Slug, TimeZone, WeeklySchedule } from "./common.js";

// ---------- Negocio ----------

/** Estilo de las respuestas del agente. */
export const AgentTone = z.enum(["warm", "professional", "brief"]);
export type AgentTone = z.infer<typeof AgentTone>;

export const Business = z.object({
  name: z.string(),
  locationName: z.string(),
  address: z.string().nullable(),
  /** se fijan en el alta (solo lectura): la moneda de los precios */
  country: Country,
  currency: Currency,
  timezone: z.string(),
  defaultLocale: Locale,
  agentTone: AgentTone,
  /** lo que el agente debe saber del negocio (dirección, estacionamiento, preguntas frecuentes) */
  agentInstructions: z.string().nullable(),
  agentInstructionsEn: z.string().nullable(),
  /** cuándo pasar la conversación a una persona */
  agentHandoff: z.string().nullable(),
  agentHandoffEn: z.string().nullable(),
  webChatSlug: z.string().nullable(),
  /** el chat público atiende (solo se activa con lo mínimo configurado) */
  chatEnabled: z.boolean(),
  /** estilo del chat público */
  chatSettings: ChatSettings,
});
export type Business = z.infer<typeof Business>;

export const BusinessPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    locationName: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).nullable(),
    timezone: TimeZone,
    defaultLocale: Locale,
    agentTone: AgentTone,
    agentInstructions: z.string().trim().max(8000).nullable(),
    agentInstructionsEn: z.string().trim().max(8000).nullable(),
    agentHandoff: z.string().trim().max(2000).nullable(),
    agentHandoffEn: z.string().trim().max(2000).nullable(),
    webChatSlug: Slug.nullable(),
    chatEnabled: z.boolean(),
    chatSettings: ChatSettings,
  })
  .partial()
  .strict();
export type BusinessPatch = z.infer<typeof BusinessPatch>;

// ---------- Servicios ----------

export const Service = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  /** versión en inglés (opcional): el agente la usa con clientes en inglés */
  nameEn: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  durationMin: z.number().int(),
  /** limpieza o preparación después del servicio */
  bufferAfterMin: z.number().int(),
  price: z.number().int().nullable(),
  active: z.boolean(),
  /** profesionales que lo hacen */
  staffIds: z.array(Id),
});
export type Service = z.infer<typeof Service>;

const serviceFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable(),
  nameEn: z.string().trim().min(1).max(120).nullable(),
  descriptionEn: z.string().trim().max(1000).nullable(),
  durationMin: z.number().int().min(5).max(720),
  bufferAfterMin: z.number().int().min(0).max(240),
  price: z.number().int().min(0).max(10_000_000).nullable(),
  active: z.boolean(),
  staffIds: z.array(Id).max(200),
};

export const ServiceCreate = z
  .object({
    ...serviceFields,
    description: serviceFields.description.default(null),
    nameEn: serviceFields.nameEn.default(null),
    descriptionEn: serviceFields.descriptionEn.default(null),
    bufferAfterMin: serviceFields.bufferAfterMin.default(0),
    price: serviceFields.price.default(null),
    active: serviceFields.active.default(true),
  })
  .strict();
export type ServiceCreate = z.infer<typeof ServiceCreate>;

export const ServicePatch = z.object(serviceFields).partial().strict();
export type ServicePatch = z.infer<typeof ServicePatch>;

// ---------- Equipo ----------

export const Staff = z.object({
  id: Id,
  name: z.string(),
  active: z.boolean(),
  /** servicios que hace */
  serviceIds: z.array(Id),
  /** horario semanal propio; null = el mismo del local */
  schedule: WeeklySchedule.nullable(),
});
export type Staff = z.infer<typeof Staff>;

export const StaffCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    active: z.boolean().default(true),
    serviceIds: z.array(Id).max(200).default([]),
  })
  .strict();
export type StaffCreate = z.infer<typeof StaffCreate>;

export const StaffPatch = z
  .object({ name: z.string().trim().min(1).max(120), active: z.boolean(), serviceIds: z.array(Id).max(200) })
  .partial()
  .strict();
export type StaffPatch = z.infer<typeof StaffPatch>;

/** Respuesta al modificar un profesional: avisos si se desactivó (no se cancela nada). */
export const StaffPatchResult = Staff.extend({
  /** reservas futuras pendientes o confirmadas con este profesional */
  futureBookings: z.number().int(),
  /** servicios activos que quedaron sin ningún profesional activo */
  servicesWithoutStaff: z.array(z.string()),
});
export type StaffPatchResult = z.infer<typeof StaffPatchResult>;

export const StaffSchedulePut = z.object({ schedule: WeeklySchedule.nullable() }).strict();
export type StaffSchedulePut = z.infer<typeof StaffSchedulePut>;

// ---------- Horario del local y cierres ----------

export const Hours = z.object({ schedule: WeeklySchedule }).strict();
export type Hours = z.infer<typeof Hours>;

export const Closure = z.object({
  id: Id,
  /** primer y último día cerrado, en fecha local (días completos) */
  from: LocalDate,
  to: LocalDate,
  /** null = todo el local; si no, solo ese profesional (vacaciones) */
  staffId: Id.nullable(),
  reason: z.string().nullable(),
});
export type Closure = z.infer<typeof Closure>;

export const ClosureCreate = z
  .object({
    from: LocalDate,
    to: LocalDate,
    staffId: Id.nullable().default(null),
    reason: z.string().trim().max(200).nullable().default(null),
  })
  .strict()
  .refine((c) => c.from <= c.to, { message: "La fecha final no puede ser anterior a la inicial", path: ["to"] })
  .refine((c) => (Date.parse(c.to) - Date.parse(c.from)) / 86_400_000 <= 366, {
    message: "Un cierre puede durar hasta un año",
    path: ["to"],
  });
export type ClosureCreate = z.infer<typeof ClosureCreate>;

// ---------- Políticas ----------

export const Policies = z
  .object({
    /** cada cuánto se ofrecen horarios (minutos) */
    slotIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    /** anticipación mínima para reservar (minutos) */
    minLeadTimeMin: z.number().int().min(0).max(10_080),
    /** hasta cuántos días hacia adelante se puede reservar */
    maxAdvanceDays: z.number().int().min(1).max(365),
    /** hasta cuántos minutos antes se puede cancelar o mover */
    cancelCutoffMin: z.number().int().min(0).max(10_080),
    /** true: la reserva queda confirmada; false: queda pendiente hasta que el negocio la confirme */
    autoConfirm: z.boolean(),
  })
  .strict();
export type Policies = z.infer<typeof Policies>;

// ---------- Canal web ----------

export const WebChatInfo = z.object({
  slug: z.string().nullable(),
  /** el chat atiende */
  enabled: z.boolean(),
  /** enlace público del chat */
  publicUrl: z.string().nullable(),
  /** script para incrustar el chat en el sitio del negocio */
  embedScriptUrl: z.string().nullable(),
  /** logo del negocio en el chat (URL con versión) */
  logoUrl: z.string().nullable(),
});
export type WebChatInfo = z.infer<typeof WebChatInfo>;
