import type {
  BookingsQuery,
  CustomerSearchResult,
  DayAgenda,
  ConversationDetail,
  ConversationPage,
  ConversationsQuery,
  ConversationSummary,
  MerchantBooking,
} from "@hablahora/contracts";
import { DateTime } from "luxon";
import { getConversationTrace } from "../agent/trace.js";
import { getExceptions, getResources, getRules, serviceDayRange } from "../db/repository.js";
import type { Tx } from "../db/tenant.js";
import type { Interval } from "../intervals.js";
import { dayWindows } from "../slots.js";
import { localDate, localTime, MerchantError, nextLocalDay, primaryLocation, startOfLocalDay } from "./common.js";

// ---------------------------------------------------------------------
// Reservas
// ---------------------------------------------------------------------

const BOOKING_SELECT = `
  SELECT b.id, b.starts_at, b.ends_at, b.status, b.source, b.conversation_id, b.notes, b.created_at,
         s.id AS service_id, s.name AS service_name,
         r.id AS staff_id, r.name AS staff_name,
         c.id AS customer_id, c.name AS customer_name, c.phone_e164, c.email
    FROM bookings b
    JOIN services s ON s.id = b.service_id
    -- el profesional: el recurso activo, o el último que tuvo si se canceló
    LEFT JOIN LATERAL (
      SELECT resource_id FROM booking_resources br WHERE br.booking_id = b.id
       ORDER BY br.is_active DESC LIMIT 1) br ON true
    LEFT JOIN resources r ON r.id = br.resource_id
    LEFT JOIN customers c ON c.id = b.customer_id`;

/** Reservas entre dos fechas locales (por hora de inicio), con filtros. */
export async function listBookings(tx: Tx, q: BookingsQuery): Promise<{ items: MerchantBooking[] }> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `${BOOKING_SELECT}
      WHERE b.location_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3
        AND ($4::booking_status[] IS NULL OR b.status = ANY($4))
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM booking_resources x WHERE x.booking_id = b.id AND x.resource_id = $5))
        AND ($6::text IS NULL OR b.source = $6)
        AND ($7::text IS NULL OR c.name ILIKE $7 OR c.email ILIKE $7 OR c.phone_e164 ILIKE $7)
      ORDER BY b.starts_at, b.created_at
      LIMIT 5000`,
    [
      loc.id,
      startOfLocalDay(q.from, loc.timezone),
      nextLocalDay(q.to, loc.timezone),
      q.status?.length ? q.status : null,
      q.staffId ?? null,
      q.source ?? null,
      q.q ? likePattern(q.q) : null,
    ],
  );
  return { items: rows.map((r) => mapBooking(r, loc.timezone)) };
}

/**
 * La agenda de un día: horario de la sucursal y de cada profesional (ya con
 * cierres y aperturas especiales) y las reservas vigentes, en minutos desde
 * la medianoche local. Un turno que cruza la medianoche pasa de 1440.
 */
export async function dayAgenda(tx: Tx, date: string, now: Date): Promise<DayAgenda> {
  const loc = await primaryLocation(tx);
  const resources = (await getResources(tx, loc.id))
    .filter((r) => r.kind === "staff" && r.isActive)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  const rules = await getRules(tx, loc.id);
  const exceptions = await getExceptions(tx, loc.id, serviceDayRange(date, loc.timezone));
  const windows = dayWindows({ timezone: loc.timezone, date, rules, exceptions }, resources);

  const dayStart = DateTime.fromISO(date, { zone: loc.timezone }).startOf("day").toMillis();
  const toMinutes = (list: Interval[]) =>
    list.map(([a, b]) => ({ start: Math.round((a - dayStart) / 60_000), end: Math.round((b - dayStart) / 60_000) }));

  const { rows } = await tx.query(
    `${BOOKING_SELECT}
      WHERE b.location_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3
        AND b.status NOT IN ('cancelled', 'expired')
        AND NOT (b.status = 'hold' AND b.hold_expires_at < $4)
      ORDER BY b.starts_at, b.created_at`,
    [loc.id, startOfLocalDay(date, loc.timezone), nextLocalDay(date, loc.timezone), now],
  );
  return {
    date,
    timezone: loc.timezone,
    open: toMinutes(windows.location),
    staff: resources.map((r) => ({ id: r.id, name: r.name, windows: toMinutes(windows.byResource.get(r.id) ?? []) })),
    bookings: rows.map((r) => ({
      ...mapBooking(r, loc.timezone),
      startMin: Math.round((r.starts_at.getTime() - dayStart) / 60_000),
      endMin: Math.round((r.ends_at.getTime() - dayStart) / 60_000),
    })),
  };
}

// ---------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------

/** Busca clientes por nombre, teléfono o email (para reservar desde la consola). */
export async function searchCustomers(tx: Tx, q: string): Promise<CustomerSearchResult> {
  const { rows } = await tx.query(
    `SELECT id, name, phone_e164, email FROM customers
      WHERE name ILIKE $1 OR email ILIKE $1 OR phone_e164 ILIKE $1
      ORDER BY name NULLS LAST, created_at DESC
      LIMIT 10`,
    [likePattern(q)],
  );
  return { items: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone_e164, email: r.email })) };
}

/** Texto libre → patrón ILIKE, sin comodines del usuario. Los dígitos de un teléfono se buscan seguidos. */
function likePattern(q: string): string {
  const text = q.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  const digits = /^[\d\s()+.-]+$/.test(text) ? text.replace(/\D/g, "") : text;
  return `%${digits}%`;
}

/** Una reserva, tal como la muestra la consola. */
export async function getBooking(tx: Tx, id: string): Promise<MerchantBooking> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(`${BOOKING_SELECT} WHERE b.id = $1 AND b.location_id = $2`, [id, loc.id]);
  if (!rows[0]) throw new MerchantError("not_found", "Reserva no encontrada");
  return mapBooking(rows[0], loc.timezone);
}

function mapBooking(r: any, zone: string): MerchantBooking {
  return {
    id: r.id,
    date: localDate(r.starts_at, zone),
    time: localTime(r.starts_at, zone),
    endTime: localTime(r.ends_at, zone),
    status: r.status,
    source: r.source,
    service: { id: r.service_id, name: r.service_name },
    staff: r.staff_id ? { id: r.staff_id, name: r.staff_name } : null,
    customer: r.customer_id ? { id: r.customer_id, name: r.customer_name, phone: r.phone_e164, email: r.email } : null,
    conversationId: r.conversation_id,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------

const CONVERSATION_SELECT = `
  SELECT c.*, c.updated_at::text AS updated_at_text,
         cu.id AS cust_id, cu.name AS customer_name, cu.phone_e164, cu.email,
         (SELECT count(*) FROM bookings b WHERE b.conversation_id = c.id)::int AS bookings_count,
         lm.content AS last_content
    FROM conversations c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    -- último mensaje con texto del cliente, del agente o del equipo
    LEFT JOIN LATERAL (
      SELECT m.content FROM conversation_messages m
       WHERE m.conversation_id = c.id AND m.author IN ('customer', 'agent', 'staff')
         AND jsonb_path_exists(m.content, '$[*] ? (@.type == "text")')
       ORDER BY m.id DESC LIMIT 1) lm ON true`;

/**
 * Conversaciones con al menos un mensaje, la más reciente primero.
 * Paginación por cursor (updated_at con microsegundos + id), estable aunque lleguen mensajes nuevos.
 */
export async function listConversations(tx: Tx, q: ConversationsQuery): Promise<ConversationPage> {
  const loc = await primaryLocation(tx);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const { rows } = await tx.query(
    `${CONVERSATION_SELECT}
      WHERE c.location_id = $1
        AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)
        AND ($2::boolean IS NULL OR c.handoff = $2)
        AND ($3::text IS NULL OR c.channel = $3)
        AND ($4::timestamptz IS NULL OR (c.updated_at, c.id) < ($4::timestamptz, $5::uuid))
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT $6`,
    [loc.id, q.handoff ?? null, q.channel ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: page.map(mapConversation),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.updated_at_text, last.id) : null,
  };
}

/** Una conversación con su traza (mensajes, llamadas al modelo, herramientas) y sus reservas. */
export async function getConversationDetail(tx: Tx, id: string): Promise<ConversationDetail> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(`${CONVERSATION_SELECT} WHERE c.id = $1 AND c.location_id = $2`, [id, loc.id]);
  if (!rows[0]) throw new MerchantError("not_found", "Conversación no encontrada");
  const bookings = await tx.query(`${BOOKING_SELECT} WHERE b.conversation_id = $1 ORDER BY b.created_at`, [id]);
  const trace = await getConversationTrace(tx, id);
  return {
    conversation: mapConversation(rows[0]),
    bookings: bookings.rows.map((r) => mapBooking(r, loc.timezone)),
    trace: {
      messages: trace.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
      // sin el costo: es de la plataforma (consola del owner), no del negocio
      llmCalls: trace.llmCalls.map(({ costUsd: _cost, ...c }) => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
        toolCalls: c.toolCalls.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
      })),
    },
  };
}

function mapConversation(r: any): ConversationSummary {
  const text = Array.isArray(r.last_content)
    ? r.last_content
        .filter((b: any) => b.type === "text")
        .map((b: any) => String(b.text))
        .join(" ")
        .trim()
    : "";
  return {
    id: r.id,
    channel: r.channel,
    customer: r.cust_id ? { name: r.customer_name, phone: r.phone_e164, email: r.email } : null,
    verifiedEmail: r.verified_email,
    handoff: r.handoff,
    handoffReason: r.handoff_reason,
    lastMessage: text ? (text.length > 160 ? `${text.slice(0, 157)}...` : text) : null,
    lastCustomerMessageAt: r.last_customer_message_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
    bookingsCount: r.bookings_count,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// timestamptz como texto de Postgres, con microsegundos: "2026-10-12 16:01:00.123456+00"
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  const [updatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!updatedAt || !id || !UUID.test(id) || !PG_TIMESTAMPTZ.test(updatedAt)) {
    throw new MerchantError("unprocessable", "Cursor inválido", "invalid_cursor");
  }
  return { updatedAt, id };
}
