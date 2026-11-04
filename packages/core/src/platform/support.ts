import type { ConversationDetail, ConversationPage, SupportLogEntry } from "@hablahora/contracts";
import { withTenant, type Db } from "../db/tenant.js";
import { MerchantError } from "../merchant/common.js";
import { getConversationDetail, listConversations } from "../merchant/read.js";

// Visor de soporte: la plataforma ve las conversaciones de un negocio (solo lectura),
// siempre con un motivo, y cada acceso queda en support_access_log.

async function assertBusiness(db: Db, tenantId: string): Promise<void> {
  const { rowCount } = await db.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
  if (!rowCount) throw new MerchantError("not_found", "Negocio no encontrado");
}

async function logAccess(db: Db, a: { tenantId: string; userId: string; reason: string; conversationId: string | null; now: Date }): Promise<void> {
  await db.query(
    "INSERT INTO support_access_log (tenant_id, user_id, reason, conversation_id, created_at) VALUES ($1, $2, $3, $4, $5)",
    [a.tenantId, a.userId, a.reason.trim(), a.conversationId, a.now],
  );
}

/**
 * Listado de conversaciones de un negocio. El acceso se registra al abrir el
 * listado; las páginas siguientes (con cursor) son el mismo acceso.
 */
export async function listBusinessConversations(
  db: Db,
  a: { tenantId: string; userId: string; reason: string; handoff?: boolean; cursor?: string; limit: number; now: Date },
): Promise<ConversationPage> {
  await assertBusiness(db, a.tenantId);
  const page = await withTenant(db, a.tenantId, (tx) =>
    listConversations(tx, { handoff: a.handoff, cursor: a.cursor, limit: a.limit }),
  );
  if (!a.cursor) await logAccess(db, { ...a, conversationId: null });
  return page;
}

/** Una conversación con su traza (sin costos). Se registra con el id de la conversación. */
export async function getBusinessConversation(
  db: Db,
  a: { tenantId: string; userId: string; reason: string; conversationId: string; now: Date },
): Promise<ConversationDetail> {
  await assertBusiness(db, a.tenantId);
  // si la conversación no es de este negocio, no hubo acceso: no se registra
  const detail = await withTenant(db, a.tenantId, (tx) => getConversationDetail(tx, a.conversationId));
  await logAccess(db, a);
  return detail;
}

/** Registro de accesos, el más reciente primero (el usuario lo agrega la API: está en el esquema auth). */
export async function listAccessLog(
  db: Db,
  q: { limit: number; cursor?: string; businessId?: string },
): Promise<{ items: (Omit<SupportLogEntry, "user"> & { userId: string })[]; nextCursor: string | null }> {
  const { rows } = await db.query(
    `SELECT l.id, l.created_at, l.user_id, l.reason, l.conversation_id, t.id AS tenant_id, t.name AS tenant_name
       FROM support_access_log l JOIN tenants t ON t.id = l.tenant_id
      WHERE ($1::bigint IS NULL OR l.id < $1) AND ($2::uuid IS NULL OR l.tenant_id = $2)
      ORDER BY l.id DESC LIMIT $3`,
    [q.cursor ?? null, q.businessId ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: Number(r.id),
      at: r.created_at.toISOString(),
      business: { id: r.tenant_id, name: r.tenant_name },
      userId: r.user_id,
      reason: r.reason,
      conversationId: r.conversation_id,
    })),
    nextCursor: rows.length > q.limit ? String(page.at(-1)!.id) : null,
  };
}
