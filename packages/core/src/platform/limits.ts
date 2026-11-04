import { DateTime } from "luxon";
import type { Db, Tx } from "../db/tenant.js";

// Límites del plan y estado del negocio. tenants y plans no tienen RLS (son el
// índice de negocios y los planes de la plataforma); las cuentas de uso pasan por RLS.

export interface TenantGate {
  status: "active" | "suspended" | "closed";
  planName: string;
  maxConversationsPerMonth: number | null;
  maxActiveStaff: number | null;
  usageWarnedMonth: string | null;
}

const GATE_SQL = `
  SELECT t.status, t.usage_warned_month, p.name AS plan_name,
         p.max_conversations_per_month, p.max_active_staff
    FROM tenants t JOIN plans p ON p.id = t.plan_id`;

function mapGate(r: any): TenantGate {
  return {
    status: r.status,
    planName: r.plan_name,
    maxConversationsPerMonth: r.max_conversations_per_month,
    maxActiveStaff: r.max_active_staff,
    usageWarnedMonth: r.usage_warned_month,
  };
}

export async function tenantGate(db: Db | Tx, tenantId: string): Promise<TenantGate | null> {
  const { rows } = await db.query(`${GATE_SQL} WHERE t.id = $1`, [tenantId]);
  return rows[0] ? mapGate(rows[0]) : null;
}

/** El del negocio de la transacción actual (withTenant). */
export async function currentTenantGate(tx: Tx): Promise<TenantGate> {
  const { rows } = await tx.query(`${GATE_SQL} WHERE t.id = current_setting('app.tenant_id')::uuid`);
  return mapGate(rows[0]);
}

/** "2026-10" en la zona del negocio. */
export const monthKey = (now: Date, timezone: string) => DateTime.fromJSDate(now, { zone: timezone }).toFormat("yyyy-LL");

/**
 * Conversaciones del mes (zona del negocio) con algún mensaje del cliente:
 * las sesiones que se abren y no escriben no cuentan.
 */
export async function conversationsThisMonth(tx: Tx, locationId: string, timezone: string, now: Date): Promise<number> {
  const start = DateTime.fromJSDate(now, { zone: timezone }).startOf("month").toJSDate();
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n FROM conversations c
      WHERE c.location_id = $1 AND c.created_at >= $2
        AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.author = 'customer')`,
    [locationId, start],
  );
  return rows[0].n;
}

export async function activeStaffCount(tx: Tx, locationId: string): Promise<number> {
  const { rows } = await tx.query(
    "SELECT count(*)::int AS n FROM resources WHERE location_id = $1 AND kind = 'staff' AND is_active",
    [locationId],
  );
  return rows[0].n;
}

/** Proporción del plan a partir de la cual se avisa (una vez por mes). */
export const USAGE_WARNING_RATIO = 0.8;
