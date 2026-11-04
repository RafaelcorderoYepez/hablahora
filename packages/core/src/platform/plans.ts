import type { Plan, PlanInput } from "@hablahora/contracts";
import type { Db } from "../db/tenant.js";
import { MerchantError } from "../merchant/common.js";

// Planes de la plataforma (sin RLS). No cobran: en la v1 no hay pagos.

const PLAN_SQL = `
  SELECT p.*, (SELECT count(*)::int FROM tenants t WHERE t.plan_id = p.id) AS businesses
    FROM plans p`;

function mapPlan(r: any): Plan {
  return {
    id: r.id,
    name: r.name,
    maxConversationsPerMonth: r.max_conversations_per_month,
    maxActiveStaff: r.max_active_staff,
    maxLocations: r.max_locations,
    isDefault: r.is_default,
    businesses: r.businesses,
  };
}

export async function listPlans(db: Db): Promise<Plan[]> {
  const { rows } = await db.query(`${PLAN_SQL} ORDER BY p.is_default DESC, p.name`);
  return rows.map(mapPlan);
}

async function getPlan(db: Db, id: string): Promise<Plan> {
  const { rows } = await db.query(`${PLAN_SQL} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new MerchantError("not_found", "Plan no encontrado", "plan_not_found");
  return mapPlan(rows[0]);
}

/** Crea o modifica un plan; marcarlo por defecto le quita la marca al anterior. */
export async function savePlan(db: Db, id: string | null, input: PlanInput): Promise<Plan> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) await client.query("UPDATE plans SET is_default = false WHERE is_default AND id IS DISTINCT FROM $1", [id]);
    if (id) {
      const current = await client.query("SELECT is_default FROM plans WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rows[0]) throw new MerchantError("not_found", "Plan no encontrado", "plan_not_found");
      // siempre tiene que haber un plan por defecto (el de las altas)
      const isDefault = input.isDefault || current.rows[0].is_default;
      await client.query(
        `UPDATE plans SET name = $2, max_conversations_per_month = $3, max_active_staff = $4, max_locations = $5, is_default = $6
          WHERE id = $1`,
        [id, input.name, input.maxConversationsPerMonth, input.maxActiveStaff, input.maxLocations, isDefault],
      );
    } else {
      const { rows } = await client.query(
        `INSERT INTO plans (name, max_conversations_per_month, max_active_staff, max_locations, is_default)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.name, input.maxConversationsPerMonth, input.maxActiveStaff, input.maxLocations, input.isDefault],
      );
      id = rows[0].id as string;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") {
      throw new MerchantError("conflict", "Ya hay un plan con ese nombre", "plan_name_taken");
    }
    throw err;
  } finally {
    client.release();
  }
  return getPlan(db, id!);
}

/** Solo se borra un plan que no usa nadie y que no es el por defecto. */
export async function deletePlan(db: Db, id: string): Promise<void> {
  const plan = await getPlan(db, id);
  if (plan.businesses > 0 || plan.isDefault) {
    throw new MerchantError("conflict", "El plan está en uso", "plan_in_use");
  }
  await db.query("DELETE FROM plans WHERE id = $1", [id]);
}
