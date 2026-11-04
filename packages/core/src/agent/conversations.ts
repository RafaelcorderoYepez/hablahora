import type Anthropic from "@anthropic-ai/sdk";
import type { CountryCode, CurrencyCode } from "@hablahora/contracts";
import { randomBytes } from "node:crypto";
import type { Tx } from "../db/tenant.js";

export type Channel = "whatsapp" | "web";
export type Locale = "es" | "en";

export interface ConversationRow {
  id: string;
  tenantId: string;
  locationId: string;
  channel: Channel;
  /** whatsapp: teléfono E.164 del cliente; web: id de la sesión anónima */
  externalId: string;
  customerId: string | null;
  /** chat web: email que el cliente probó con un código (ve las reservas de ese email) */
  verifiedEmail: string | null;
  customerProfileName: string | null;
  handoff: boolean;
  /** idioma de los textos fijos y de la interfaz; null = el de la sucursal */
  locale: Locale | null;
}

export interface AgentSettings {
  tenantName: string;
  country: CountryCode;
  currency: CurrencyCode;
  vertical: string;
  locationName: string;
  timezone: string;
  tone: "warm" | "professional" | "brief";
  /** lo que el agente debe saber, en español y (opcional) en inglés */
  instructions: string | null;
  instructionsEn: string | null;
  /** cuándo pasar a una persona */
  handoff: string | null;
  handoffEn: string | null;
  defaultLocale: string;
  /** modelo del negocio o, si no tiene, el de la plataforma; null = el del servidor (CLAUDE_MODEL) */
  model: string | null;
}

export type Author = "customer" | "agent" | "tool" | "staff" | "system";

/**
 * Contexto para el agente a mitad de la conversación (fecha y hora, idioma, si el
 * cliente ya dejó sus datos). Va como mensaje de sistema y queda guardado: el
 * `system` de cada llamada no cambia, y los bloques de pensamiento del modelo
 * siguen siendo válidos en los turnos siguientes (la API los liga a todo lo anterior).
 */
export interface SystemMessage {
  role: "system";
  content: string;
}

/** Un mensaje del historial tal como se manda a la API (incluye `role: "system"`). */
export type HistoryMessage = Anthropic.MessageParam;

/** Registra un mensaje entrante: crea la conversación si es nueva. */
export async function upsertConversation(
  tx: Tx,
  a: { tenantId: string; locationId: string; channel: Channel; externalId: string; profileName?: string; now: Date },
): Promise<ConversationRow> {
  const { rows } = await tx.query(
    `INSERT INTO conversations (tenant_id, location_id, channel, external_id, customer_profile_name, last_customer_message_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, channel, external_id) DO UPDATE
       SET customer_profile_name = coalesce(EXCLUDED.customer_profile_name, conversations.customer_profile_name),
           last_customer_message_at = EXCLUDED.last_customer_message_at,
           updated_at = EXCLUDED.last_customer_message_at
     RETURNING *`,
    [a.tenantId, a.locationId, a.channel, a.externalId, a.profileName ?? null, a.now],
  );
  return mapConversation(rows[0]);
}

/**
 * Sesión anónima del chat web. El id es un secreto de 128 bits: quien lo
 * tiene puede escribir en esa conversación.
 */
export async function createWebConversation(
  tx: Tx,
  a: { tenantId: string; locationId: string; locale: Locale },
): Promise<ConversationRow> {
  const sessionId = randomBytes(16).toString("base64url");
  const { rows } = await tx.query(
    `INSERT INTO conversations (tenant_id, location_id, channel, external_id, locale)
     VALUES ($1, $2, 'web', $3, $4) RETURNING *`,
    [a.tenantId, a.locationId, sessionId, a.locale],
  );
  return mapConversation(rows[0]);
}

export async function setConversationLocale(tx: Tx, conversationId: string, locale: Locale): Promise<void> {
  await tx.query("UPDATE conversations SET locale = $2 WHERE id = $1", [conversationId, locale]);
}

export async function findConversation(
  tx: Tx,
  a: { locationId: string; channel: Channel; externalId: string },
): Promise<ConversationRow | null> {
  const { rows } = await tx.query(
    "SELECT * FROM conversations WHERE location_id = $1 AND channel = $2 AND external_id = $3",
    [a.locationId, a.channel, a.externalId],
  );
  return rows[0] ? mapConversation(rows[0]) : null;
}

export async function touchConversation(tx: Tx, conversationId: string, now: Date): Promise<void> {
  await tx.query("UPDATE conversations SET last_customer_message_at = $2, updated_at = $2 WHERE id = $1", [
    conversationId,
    now,
  ]);
}

export async function getConversation(tx: Tx, id: string): Promise<ConversationRow | null> {
  const { rows } = await tx.query("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0] ? mapConversation(rows[0]) : null;
}

function mapConversation(r: any): ConversationRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    locationId: r.location_id,
    channel: r.channel,
    externalId: r.external_id,
    customerId: r.customer_id,
    verifiedEmail: r.verified_email,
    customerProfileName: r.customer_profile_name,
    handoff: r.handoff,
    locale: r.locale ?? null,
  };
}

export async function getAgentSettings(tx: Tx, locationId: string): Promise<AgentSettings | null> {
  const { rows } = await tx.query(
    `SELECT t.name AS tenant_name, t.country, t.currency, t.vertical, l.name AS location_name, l.timezone,
            l.agent_tone, l.agent_instructions, l.agent_instructions_en, l.agent_handoff, l.agent_handoff_en,
            l.default_locale,
            coalesce(t.agent_model, (SELECT default_model FROM platform_settings)) AS model
       FROM locations l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = $1`,
    [locationId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    tenantName: r.tenant_name,
    country: r.country,
    currency: r.currency,
    vertical: r.vertical,
    locationName: r.location_name,
    timezone: r.timezone,
    tone: r.agent_tone ?? "warm",
    instructions: r.agent_instructions,
    instructionsEn: r.agent_instructions_en,
    handoff: r.agent_handoff,
    handoffEn: r.agent_handoff_en,
    defaultLocale: r.default_locale,
    model: r.model,
  };
}

export async function appendMessage(
  tx: Tx,
  conv: { id: string; tenantId: string },
  message: HistoryMessage,
  author: Author,
  waMessageId?: string,
): Promise<void> {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  await tx.query(
    `INSERT INTO conversation_messages (tenant_id, conversation_id, role, content, author, wa_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conv.tenantId, conv.id, message.role, JSON.stringify(content), author, waMessageId ?? null],
  );
}

/** Marca con la que el modelo reconoce lo que escribió una persona del equipo. */
export const STAFF_MESSAGE_PREFIX = "[Persona del equipo]";

/**
 * Últimos `limit` mensajes, normalizados para reenviarlos al modelo. Las
 * respuestas del equipo (paso a humano) van marcadas, para que el agente no
 * las tome como propias.
 */
export async function loadHistory(tx: Tx, conversationId: string, limit = 40): Promise<HistoryMessage[]> {
  const { rows } = await tx.query(
    `SELECT role, author, content FROM conversation_messages
      WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return normalizeHistory(rows.reverse().map(toHistoryMessage));
}

function toHistoryMessage(r: { role: string; author: string; content: Block[] }): HistoryMessage {
  if (r.role === "system") return { role: "system", content: textOfBlocks(r.content) };
  const content =
    r.author === "staff"
      ? r.content.map((b) => (b.type === "text" ? { ...b, text: `${STAFF_MESSAGE_PREFIX} ${b.text}` } : b))
      : r.content;
  return { role: r.role as "user" | "assistant", content: content as Anthropic.ContentBlockParam[] };
}

const textOfBlocks = (content: Block[]) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n");

export async function setHandoff(tx: Tx, conversationId: string, reason: string, now: Date): Promise<void> {
  await tx.query(
    "UPDATE conversations SET handoff = true, handoff_reason = $2, handoff_at = $3, updated_at = $3 WHERE id = $1",
    [conversationId, reason, now],
  );
}

/** Lo llama el panel del negocio cuando el humano devuelve la conversación al agente. */
export async function releaseHandoff(tx: Tx, conversationId: string, now: Date): Promise<void> {
  await tx.query(
    "UPDATE conversations SET handoff = false, handoff_reason = NULL, updated_at = $2 WHERE id = $1",
    [conversationId, now],
  );
}

// ---------------------------------------------------------------------

type Block = { type: string; id?: string; tool_use_id?: string; [k: string]: unknown };

/**
 * Deja el historial en una forma que la API siempre acepta, aunque haya
 * quedado a medias (un crash entre un tool_use y su tool_result, mensajes
 * del cliente mientras atendía un humano, un recorte que partió un par):
 * - empieza con un mensaje del cliente con texto
 * - todo tool_use tiene su tool_result en el mensaje siguiente, y viceversa
 * - roles alternados (los mensajes seguidos del mismo rol se fusionan)
 */
export function normalizeHistory(messages: HistoryMessage[]): HistoryMessage[] {
  const blocks = (m: Anthropic.MessageParam): Block[] =>
    (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) as Block[];
  type Entry = { role: "user" | "assistant"; content: Block[] } | SystemMessage;

  // 1. quitar pares tool_use / tool_result incompletos (los mensajes de sistema pasan tal cual)
  const kept: Entry[] = [];
  const turns = messages.filter((m): m is Anthropic.MessageParam => m.role !== "system");
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : textOfBlocks(m.content as Block[]);
      if (text.trim()) kept.push({ role: "system", content: text });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    let content = blocks(m);
    if (m.role === "assistant") {
      const uses = content.filter((b) => b.type === "tool_use").map((b) => b.id);
      if (uses.length) {
        // el resultado es el siguiente mensaje que no sea de sistema
        const next = turns[turns.indexOf(m) + 1];
        const results = next && next.role === "user" ? blocks(next).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [];
        const complete = uses.every((id) => results.includes(id));
        if (!complete) content = content.filter((b) => b.type !== "tool_use");
      }
    } else {
      const prev = [...kept].reverse().find((e) => e.role !== "system");
      const prevUses = prev && prev.role === "assistant" ? prev.content.filter((b) => b.type === "tool_use").map((b) => b.id) : [];
      content = content.filter((b) => b.type !== "tool_result" || prevUses.includes(b.tool_use_id));
    }
    content = content.filter((b) => b.type !== "text" || String(b.text ?? "").trim() !== "");
    if (content.length) kept.push({ role: m.role as "user" | "assistant", content });
  }

  // 2. un mensaje de sistema va después de uno del cliente (o de resultados de tools) y antes
  //    de una respuesta del agente, o al final; si no (p. ej. un turno que falló), se omite
  const placed = kept.filter((m, i) => {
    if (m.role !== "system") return true;
    const prev = kept[i - 1];
    const next = kept[i + 1];
    return prev?.role === "user" && (!next || next.role === "assistant");
  });

  // 3. fusionar roles consecutivos (tool_result siempre primero dentro del mensaje); el sistema no se fusiona
  const merged: Entry[] = [];
  for (const m of placed) {
    const last = merged[merged.length - 1];
    if (m.role !== "system" && last && last.role === m.role) last.content.push(...m.content);
    else merged.push(m.role === "system" ? m : { role: m.role, content: [...m.content] });
  }
  for (const m of merged) {
    if (m.role === "user") {
      m.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
    }
  }

  // 4. empezar en un mensaje del cliente que no sea respuesta de tools
  const start = merged.findIndex((m) => m.role === "user" && !m.content.some((b) => b.type === "tool_result"));
  if (start === -1) return [];
  return merged.slice(start) as HistoryMessage[];
}

/** Modelos que aceptan mensajes `role: "system"` a mitad de la conversación (Haiku 5.5 no). */
export function supportsSystemMessages(model: string): boolean {
  return /^claude-(sonnet-5-5|opus-5|opus-4-8|fable|mythos)/.test(model);
}

/**
 * El historial como lo recibe un modelo: si no acepta mensajes de sistema a mitad de
 * la conversación, el contexto va como texto al final del mensaje anterior del cliente
 * (siempre igual, para que lo ya enviado no cambie).
 */
export function forModel(messages: HistoryMessage[], model: string): Anthropic.MessageParam[] {
  if (supportsSystemMessages(model)) return messages as Anthropic.MessageParam[];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role !== "system") {
      out.push(m);
      continue;
    }
    const prev = out[out.length - 1];
    const note: Anthropic.TextBlockParam = { type: "text", text: `<contexto>\n${m.content}\n</contexto>` };
    if (prev?.role === "user") {
      const content = typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content;
      out[out.length - 1] = { role: "user", content: [...content, note] };
    }
  }
  return out;
}
