import { z } from "zod";
import { Country, Currency, Id, Locale, Slug, TimeZone } from "./common.js";

// ---------- Consola del owner (plataforma) ----------

/** Modelos que se pueden elegir: los que tienen precio conocido (core/agent/pricing.ts). */
export const AGENT_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] as const;
export const AgentModel = z.enum(AGENT_MODELS);
export type AgentModel = z.infer<typeof AgentModel>;

/** Plantillas por rubro para el alta: servicios de ejemplo y horario típico. */
export const BUSINESS_TEMPLATES = ["salon", "barberia", "clinica", "estetica"] as const;
export const BusinessTemplate = z.enum(BUSINESS_TEMPLATES);
export type BusinessTemplate = z.infer<typeof BusinessTemplate>;

export const BusinessStatus = z.enum(["active", "suspended", "closed"]);
export type BusinessStatus = z.infer<typeof BusinessStatus>;

// ---------- Planes ----------

/** null = sin límite */
const Limit = z.number().int().min(1).max(1_000_000).nullable();

export const Plan = z.object({
  id: Id,
  name: z.string(),
  maxConversationsPerMonth: Limit,
  maxActiveStaff: Limit,
  maxLocations: z.number().int(),
  isDefault: z.boolean(),
  /** negocios que lo usan */
  businesses: z.number().int(),
});
export type Plan = z.infer<typeof Plan>;

export const PlanInput = z
  .object({
    name: z.string().trim().min(1, "Escribe el nombre").max(60),
    maxConversationsPerMonth: Limit,
    maxActiveStaff: Limit,
    maxLocations: z.number().int().min(1).max(100).default(1),
    /** el de los negocios nuevos (solo puede haber uno) */
    isDefault: z.boolean().default(false),
  })
  .strict();
export type PlanInput = z.infer<typeof PlanInput>;

// ---------- Negocios ----------

export const PlatformBusiness = z.object({
  id: Id,
  name: z.string(),
  vertical: z.string(),
  country: Country,
  currency: Currency,
  status: BusinessStatus,
  statusChangedAt: z.string().nullable(),
  plan: z.object({ id: Id, name: z.string() }),
  /** null = el de la plataforma */
  agentModel: z.string().nullable(),
  slug: z.string().nullable(),
  chatEnabled: z.boolean(),
  owner: z.object({ name: z.string(), email: z.string() }).nullable(),
  createdAt: z.string(),
  usage: z.object({
    /** conversaciones con algún mensaje del cliente en el mes (zona del negocio) */
    conversationsThisMonth: z.number().int(),
    maxConversationsPerMonth: z.number().int().nullable(),
    activeStaff: z.number().int(),
    maxActiveStaff: z.number().int().nullable(),
  }),
});
export type PlatformBusiness = z.infer<typeof PlatformBusiness>;

/** POST /api/platform/businesses */
export const PlatformBusinessCreate = z
  .object({
    name: z.string().trim().min(1, "Escribe el nombre").max(120),
    template: BusinessTemplate,
    owner: z
      .object({ name: z.string().trim().min(1, "Escribe el nombre").max(120), email: z.email("Escribe un correo válido").max(200) })
      .strict(),
    /** por defecto, Chile; fija la moneda y no se cambia después */
    country: Country.default("CL"),
    /** sin zona ni idioma, los del país (COUNTRIES) */
    timezone: TimeZone.optional(),
    locale: Locale.optional(),
    planId: Id.optional(),
    slug: Slug.optional(),
  })
  .strict();
export type PlatformBusinessCreate = z.infer<typeof PlatformBusinessCreate>;

/** PATCH /api/platform/businesses/:id */
export const PlatformBusinessPatch = z
  .object({
    planId: Id.optional(),
    /** null = volver al de la plataforma */
    agentModel: AgentModel.nullable().optional(),
    status: BusinessStatus.optional(),
  })
  .strict();
export type PlatformBusinessPatch = z.infer<typeof PlatformBusinessPatch>;

// ---------- Configuración y usuarios ----------

export const PlatformSettings = z.object({
  /** null = el de la variable CLAUDE_MODEL del servidor */
  defaultModel: AgentModel.nullable(),
  /** el que se usa cuando defaultModel es null */
  serverModel: z.string(),
  models: z.array(z.string()),
  /** aviso de privacidad del chat público */
  privacyEs: z.string().nullable(),
  privacyEn: z.string().nullable(),
});
export type PlatformSettings = z.infer<typeof PlatformSettings>;

/** Texto del aviso de privacidad del chat (vacío = sin enlace). */
const PrivacyText = z
  .string()
  .trim()
  .max(20_000)
  .nullable()
  .transform((v) => (v ? v : null));

export const PlatformSettingsPut = z
  .object({ defaultModel: AgentModel.nullable(), privacyEs: PrivacyText.optional(), privacyEn: PrivacyText.optional() })
  .strict();
export type PlatformSettingsPut = z.infer<typeof PlatformSettingsPut>;

export const PlatformUser = z.object({ id: z.string(), name: z.string(), email: z.string(), createdAt: z.string() });
export type PlatformUser = z.infer<typeof PlatformUser>;

export const PlatformUserInvite = z
  .object({ name: z.string().trim().min(1, "Escribe el nombre").max(120), email: z.email("Escribe un correo válido").max(200) })
  .strict();
export type PlatformUserInvite = z.infer<typeof PlatformUserInvite>;

// ---------- Operación y monitoreo (H6, parte 2) ----------

/** Querystring: GET /api/platform/overview?days=30 (7, 30 o 90) */
export const OverviewQuery = z.object({ days: z.enum(["7", "30", "90"]).default("30").transform(Number) }).strict();
export type OverviewQuery = z.infer<typeof OverviewQuery>;

/** Panel general: días en UTC (la plataforma junta negocios de varias zonas horarias). */
export const PlatformOverview = z.object({
  from: z.string(),
  to: z.string(),
  businesses: z.object({ total: z.number().int(), active: z.number().int(), suspended: z.number().int(), closed: z.number().int() }),
  totals: z.object({ conversations: z.number().int(), bookings: z.number().int(), errors: z.number().int() }),
  days: z.array(
    z.object({ date: z.string(), conversations: z.number().int(), bookings: z.number().int(), errors: z.number().int() }),
  ),
});
export type PlatformOverview = z.infer<typeof PlatformOverview>;

/** Querystring: GET /api/platform/usage?month=2026-10 (sin mes, el actual) */
export const UsageQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes inválido (AAAA-MM)").optional() }).strict();
export type UsageQuery = z.infer<typeof UsageQuery>;

const TokenTotals = z.object({
  llmCalls: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  /** costo estimado de las llamadas con precio conocido */
  costUsd: z.number(),
});

/** Uso y costo del modelo del mes, por negocio (mes en la zona horaria de cada negocio). */
export const PlatformUsage = z.object({
  month: z.string(),
  totals: TokenTotals.extend({ conversations: z.number().int() }),
  businesses: z.array(
    TokenTotals.extend({
      id: Id,
      name: z.string(),
      status: BusinessStatus,
      plan: z.object({ id: Id, name: z.string() }),
      conversations: z.number().int(),
      maxConversationsPerMonth: z.number().int().nullable(),
      costPerConversationUsd: z.number().nullable(),
      /** llamadas sin precio conocido (modelo fuera de la tabla): su costo no está en el total */
      unpricedCalls: z.number().int(),
    }),
  ),
});
export type PlatformUsage = z.infer<typeof PlatformUsage>;

const Rate = z.object({ calls: z.number().int(), errors: z.number().int(), errorRate: z.number() });

/** Salud de los últimos 7 días y lo que espera al equipo ahora. */
export const PlatformHealth = z.object({
  windowDays: z.number().int(),
  /** minutos sin respuesta a partir de los cuales una conversación se considera desatendida */
  waitThresholdMin: z.number().int(),
  agent: Rate.extend({ p50Ms: z.number().nullable(), p95Ms: z.number().nullable() }),
  tools: Rate.extend({ failing: z.array(z.object({ name: z.string(), calls: z.number().int(), errors: z.number().int() })) }),
  /** conversaciones en paso a humano sin respuesta del equipo */
  waiting: z.array(
    z.object({
      tenantId: Id,
      tenantName: z.string(),
      conversationId: Id,
      waitingMin: z.number().int(),
      reason: z.string().nullable(),
    }),
  ),
  byBusiness: z.array(Rate.extend({ id: Id, name: z.string(), p95Ms: z.number().nullable() })),
});
export type PlatformHealth = z.infer<typeof PlatformHealth>;

// ---------- Soporte: ver conversaciones de un negocio, con registro ----------

/** Sin motivo no se entra: queda en el registro. */
export const SupportReason = z.string().trim().min(5, "Escribe el motivo (al menos 5 caracteres)").max(300);

/** POST /api/platform/support/businesses/:id/conversations */
export const SupportConversationsBody = z
  .object({
    reason: SupportReason,
    handoff: z.boolean().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export type SupportConversationsBody = z.infer<typeof SupportConversationsBody>;

/** POST /api/platform/support/businesses/:id/conversations/:conversationId */
export const SupportDetailBody = z.object({ reason: SupportReason }).strict();
export type SupportDetailBody = z.infer<typeof SupportDetailBody>;

/** Querystring: GET /api/platform/support/log?limit=50&cursor=… */
export const SupportLogQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().regex(/^\d{1,18}$/).optional(),
    businessId: Id.optional(),
  })
  .strict();
export type SupportLogQuery = z.infer<typeof SupportLogQuery>;

export const SupportLogEntry = z.object({
  id: z.number().int(),
  at: z.string(),
  business: z.object({ id: Id, name: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  reason: z.string(),
  /** null = vio el listado de conversaciones */
  conversationId: Id.nullable(),
});
export type SupportLogEntry = z.infer<typeof SupportLogEntry>;

export const SupportLogPage = z.object({ items: z.array(SupportLogEntry), nextCursor: z.string().nullable() });
export type SupportLogPage = z.infer<typeof SupportLogPage>;
