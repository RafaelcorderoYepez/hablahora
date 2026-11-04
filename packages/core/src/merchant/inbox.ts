import { releaseHandoff, setHandoff } from "../agent/conversations.js";
import type { Tx } from "../db/tenant.js";
import { MerchantError, primaryLocation } from "./common.js";

// Bandeja de paso a humano: el equipo responde, toma o devuelve una conversación.
// Mientras `handoff` está activo, el agente no responde (ver AgentRunner).

/** Conversaciones que esperan al equipo (contador del menú). */
export async function handoffCount(tx: Tx): Promise<{ count: number }> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query("SELECT count(*)::int AS n FROM conversations WHERE location_id = $1 AND handoff", [loc.id]);
  return { count: rows[0].n };
}

async function lockConversation(tx: Tx, id: string) {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query("SELECT * FROM conversations WHERE id = $1 AND location_id = $2 FOR UPDATE", [id, loc.id]);
  if (!rows[0]) throw new MerchantError("not_found", "Conversación no encontrada");
  return rows[0];
}

/**
 * Respuesta de una persona del equipo. Solo con la conversación en sus manos
 * y, en la v1, solo en el chat web (WhatsApp está apagado).
 */
export async function staffReply(tx: Tx, a: { conversationId: string; userId: string; text: string; now: Date }): Promise<void> {
  const conv = await lockConversation(tx, a.conversationId);
  if (conv.channel !== "web") {
    throw new MerchantError("unprocessable", "Por ahora solo se responde desde aquí en el chat web", "channel_not_supported");
  }
  if (!conv.handoff) {
    throw new MerchantError("conflict", "Toma la conversación antes de responder", "not_in_handoff");
  }
  await tx.query(
    `INSERT INTO conversation_messages (tenant_id, conversation_id, role, content, author, author_user_id)
     VALUES ($1, $2, 'assistant', $3, 'staff', $4)`,
    [conv.tenant_id, conv.id, JSON.stringify([{ type: "text", text: a.text }]), a.userId],
  );
  await tx.query("UPDATE conversations SET updated_at = $2 WHERE id = $1", [conv.id, a.now]);
}

/** El equipo toma la conversación: el agente deja de responder. */
export async function takeConversation(tx: Tx, a: { conversationId: string; userId: string; now: Date }): Promise<void> {
  const conv = await lockConversation(tx, a.conversationId);
  if (!conv.handoff) await setHandoff(tx, conv.id, `staff:${a.userId}`, a.now);
}

/** Devuelve la conversación al agente. */
export async function releaseConversation(tx: Tx, a: { conversationId: string; now: Date }): Promise<void> {
  const conv = await lockConversation(tx, a.conversationId);
  if (conv.handoff) await releaseHandoff(tx, conv.id, a.now);
}
