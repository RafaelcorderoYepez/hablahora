import type { BusinessStatus, PlatformBusiness, PlatformBusinessPatch } from "@hablahora/contracts";
import { withTenant, type Db } from "../db/tenant.js";
import { MerchantError } from "../merchant/common.js";
import { activeStaffCount, conversationsThisMonth } from "./limits.js";

/** Un negocio para la consola del owner (sin el dueño: está en el esquema auth, lo agrega la API). */
export type PlatformBusinessRow = Omit<PlatformBusiness, "owner"> & { organizationId: string | null };

const TENANT_SQL = `
  SELECT t.*, p.name AS plan_name, p.max_conversations_per_month, p.max_active_staff
    FROM tenants t JOIN plans p ON p.id = t.plan_id`;

/**
 * Negocios con su uso del mes. Cada negocio se lee con su propio withTenant():
 * la plataforma no tiene un acceso que se salte RLS.
 */
export async function listBusinesses(db: Db, now: Date): Promise<PlatformBusinessRow[]> {
  const { rows } = await db.query(`${TENANT_SQL} ORDER BY t.created_at DESC, t.name`);
  const out: PlatformBusinessRow[] = [];
  for (const t of rows) out.push(await withUsage(db, t, now));
  return out;
}

export async function getBusiness(db: Db, id: string, now: Date): Promise<PlatformBusinessRow> {
  const { rows } = await db.query(`${TENANT_SQL} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new MerchantError("not_found", "Negocio no encontrado");
  return withUsage(db, rows[0], now);
}

async function withUsage(db: Db, t: any, now: Date): Promise<PlatformBusinessRow> {
  const usage = await withTenant(db, t.id, async (tx) => {
    const { rows } = await tx.query("SELECT id, timezone, web_chat_slug, chat_enabled FROM locations ORDER BY created_at, id LIMIT 1");
    const loc = rows[0];
    if (!loc) return { slug: null, chatEnabled: false, conversations: 0, staff: 0 };
    return {
      slug: loc.web_chat_slug as string | null,
      chatEnabled: loc.chat_enabled as boolean,
      conversations: await conversationsThisMonth(tx, loc.id, loc.timezone, now),
      staff: await activeStaffCount(tx, loc.id),
    };
  });
  return {
    id: t.id,
    organizationId: t.auth_organization_id,
    name: t.name,
    vertical: t.vertical,
    country: t.country,
    currency: t.currency,
    status: t.status,
    statusChangedAt: t.status_changed_at?.toISOString() ?? null,
    plan: { id: t.plan_id, name: t.plan_name },
    agentModel: t.agent_model,
    slug: usage.slug,
    chatEnabled: usage.chatEnabled,
    createdAt: t.created_at.toISOString(),
    usage: {
      conversationsThisMonth: usage.conversations,
      maxConversationsPerMonth: t.max_conversations_per_month,
      activeStaff: usage.staff,
      maxActiveStaff: t.max_active_staff,
    },
  };
}

/** Plan, modelo del agente y estado (suspender, reactivar, dar de baja). */
export async function updateBusiness(db: Db, id: string, patch: PlatformBusinessPatch, now: Date): Promise<PlatformBusinessRow> {
  const { rows } = await db.query("SELECT status FROM tenants WHERE id = $1", [id]);
  if (!rows[0]) throw new MerchantError("not_found", "Negocio no encontrado");
  if (patch.planId) {
    const plan = await db.query("SELECT 1 FROM plans WHERE id = $1", [patch.planId]);
    if (!plan.rowCount) throw new MerchantError("unprocessable", "Plan no encontrado", "plan_not_found");
    await db.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [id, patch.planId]);
  }
  if (patch.agentModel !== undefined) {
    await db.query("UPDATE tenants SET agent_model = $2 WHERE id = $1", [id, patch.agentModel]);
  }
  if (patch.status && patch.status !== (rows[0].status as BusinessStatus)) {
    await db.query("UPDATE tenants SET status = $2, status_changed_at = $3 WHERE id = $1", [id, patch.status, now]);
  }
  return getBusiness(db, id, now);
}
