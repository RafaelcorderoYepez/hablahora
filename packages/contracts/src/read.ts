import { z } from "zod";
import { CustomerContact, Id, LocalDate, LocalTime } from "./common.js";

// ---------- Reservas ----------

// igual que el tipo booking_status de la base ("seated" es de mesas)
export const BookingStatus = z.enum(["hold", "pending", "confirmed", "seated", "completed", "cancelled", "no_show", "expired"]);
export type BookingStatus = z.infer<typeof BookingStatus>;

/** Querystring: GET /api/merchant/bookings?from=2026-10-01&to=2026-10-31&status=confirmed,pending */
export const BookingsQuery = z
  .object({
    from: LocalDate,
    to: LocalDate,
    status: z
      .string()
      .transform((s) => s.split(",").filter(Boolean))
      .pipe(z.array(BookingStatus))
      .optional(),
    staffId: Id.optional(),
    /** web, whatsapp, staff… */
    source: z.string().max(20).optional(),
    /** nombre, teléfono o email del cliente */
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: "La fecha final no puede ser anterior a la inicial", path: ["to"] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 62, {
    message: "El rango puede ser de hasta 62 días",
    path: ["to"],
  });
export type BookingsQuery = z.infer<typeof BookingsQuery>;

export const MerchantBooking = z.object({
  id: Id,
  /** fecha y horas locales del negocio */
  date: LocalDate,
  time: LocalTime,
  endTime: LocalTime,
  status: z.string(),
  /** origen: web, whatsapp, staff… */
  source: z.string(),
  service: z.object({ id: Id, name: z.string() }),
  staff: z.object({ id: Id, name: z.string() }).nullable(),
  customer: CustomerContact.extend({ id: Id }).nullable(),
  conversationId: Id.nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type MerchantBooking = z.infer<typeof MerchantBooking>;

export const BookingList = z.object({ items: z.array(MerchantBooking) });
export type BookingList = z.infer<typeof BookingList>;

// ---------- Agenda del día ----------

/** Querystring: GET /api/merchant/agenda?date=2026-10-12 */
export const AgendaQuery = z.object({ date: LocalDate }).strict();
export type AgendaQuery = z.infer<typeof AgendaQuery>;

/** Tramo en minutos desde la medianoche local del día (puede pasar de 1440 si cruza la medianoche). */
export const MinuteRange = z.object({ start: z.number().int(), end: z.number().int() });
export type MinuteRange = z.infer<typeof MinuteRange>;

export const AgendaBooking = MerchantBooking.extend({ startMin: z.number().int(), endMin: z.number().int() });
export type AgendaBooking = z.infer<typeof AgendaBooking>;

export const DayAgenda = z.object({
  date: LocalDate,
  timezone: z.string(),
  /** horario de la sucursal ese día, con cierres y aperturas especiales */
  open: z.array(MinuteRange),
  /** profesionales activos, con su horario de ese día */
  staff: z.array(z.object({ id: Id, name: z.string(), windows: z.array(MinuteRange) })),
  /** reservas vigentes (sin canceladas ni apartados vencidos) */
  bookings: z.array(AgendaBooking),
});
export type DayAgenda = z.infer<typeof DayAgenda>;

// ---------- Clientes ----------

/** Querystring: GET /api/merchant/customers?q=ana */
export const CustomerSearchQuery = z.object({ q: z.string().trim().min(2).max(100) }).strict();

export const CustomerSearchResult = z.object({
  items: z.array(CustomerContact.extend({ id: Id })),
});
export type CustomerSearchResult = z.infer<typeof CustomerSearchResult>;

// ---------- Conversaciones ----------

export const ConversationsQuery = z
  .object({
    handoff: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    channel: z.enum(["web", "whatsapp"]).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type ConversationsQuery = z.infer<typeof ConversationsQuery>;

export const ConversationSummary = z.object({
  id: Id,
  channel: z.string(),
  customer: CustomerContact.nullable(),
  verifiedEmail: z.string().nullable(),
  handoff: z.boolean(),
  handoffReason: z.string().nullable(),
  /** último texto del cliente, del agente o del equipo (recortado) */
  lastMessage: z.string().nullable(),
  lastCustomerMessageAt: z.string().nullable(),
  updatedAt: z.string(),
  bookingsCount: z.number().int(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationPage = z.object({
  items: z.array(ConversationSummary),
  /** para la página siguiente; null si no hay más */
  nextCursor: z.string().nullable(),
});
export type ConversationPage = z.infer<typeof ConversationPage>;

export const TraceToolCall = z.object({
  id: z.number(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
  result: z.unknown(),
  isError: z.boolean(),
  durationMs: z.number(),
  createdAt: z.string(),
});

export const TraceLlmCall = z.object({
  id: z.number(),
  turnId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  durationMs: z.number(),
  stopReason: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  toolCalls: z.array(TraceToolCall),
});

export const TraceMessage = z.object({
  id: z.number(),
  role: z.enum(["user", "assistant", "system"]),
  /** customer | agent | tool | staff */
  author: z.string(),
  /** quién del equipo lo escribió (respuestas en el paso a humano) */
  authorUserId: z.string().nullable(),
  content: z.array(z.unknown()),
  createdAt: z.string(),
});

export const ConversationDetail = z.object({
  conversation: ConversationSummary,
  bookings: z.array(MerchantBooking),
  trace: z.object({ messages: z.array(TraceMessage), llmCalls: z.array(TraceLlmCall) }),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

// ---------- Bandeja de paso a humano ----------

/** POST /api/merchant/conversations/:id/reply */
export const StaffReply = z.object({ text: z.string().trim().min(1, "Escribe un mensaje").max(2000) }).strict();
export type StaffReply = z.infer<typeof StaffReply>;

/** GET /api/merchant/handoff/count */
export const HandoffCount = z.object({ count: z.number().int() });
export type HandoffCount = z.infer<typeof HandoffCount>;

// ---------- Métricas ----------

/** Querystring: GET /api/merchant/metrics?from=2026-09-20&to=2026-10-19 (hasta 92 días) */
export const MetricsQuery = z
  .object({ from: LocalDate, to: LocalDate })
  .strict()
  .refine((q) => q.from <= q.to, { message: "La fecha final no puede ser anterior a la inicial", path: ["to"] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92, {
    message: "El rango puede ser de hasta 92 días",
    path: ["to"],
  });
export type MetricsQuery = z.infer<typeof MetricsQuery>;

const StatusCounts = z.object({
  pending: z.number().int(),
  confirmed: z.number().int(),
  completed: z.number().int(),
  noShow: z.number().int(),
  cancelled: z.number().int(),
});

export const Metrics = z.object({
  from: LocalDate,
  to: LocalDate,
  /** reservas que empiezan en el período; `booked` = todas menos las canceladas */
  totals: StatusCounts.extend({ booked: z.number().int() }),
  days: z.array(StatusCounts.extend({ date: LocalDate })),
  /** reservas no canceladas por origen (web, whatsapp, staff) */
  bySource: z.array(z.object({ source: z.string(), count: z.number().int() })),
  topServices: z.array(z.object({ id: Id, name: z.string(), count: z.number().int() })),
  chat: z.object({
    /** conversaciones con algún mensaje del cliente, empezadas en el período */
    conversations: z.number().int(),
    withBooking: z.number().int(),
    handedOff: z.number().int(),
    /** mediana de lo que tardó el equipo en responder tras el paso a humano */
    medianTeamReplyMin: z.number().int().nullable(),
  }),
  /** minutos reservados sobre minutos de horario de cada profesional activo */
  occupancy: z.array(
    z.object({ staffId: Id, name: z.string(), bookedMin: z.number().int(), availableMin: z.number().int(), ratio: z.number().nullable() }),
  ),
});
export type Metrics = z.infer<typeof Metrics>;
