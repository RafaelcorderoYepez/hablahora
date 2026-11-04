import type { ErrorReason, WeeklySchedule } from "@hablahora/contracts";
import { DateTime } from "luxon";
import type { Tx } from "../db/tenant.js";

/** Error de negocio de la consola: la API lo traduce a 404, 409 o 422. */
export class MerchantError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "unprocessable",
    message: string,
    /** motivo para que la consola lo explique en su idioma */
    public reason: ErrorReason = code === "not_found" ? "not_found" : "chat_not_ready",
    /** detalle opcional (p. ej. qué falta para activar el chat) */
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface MerchantLocation {
  id: string;
  timezone: string;
}

/**
 * La sucursal del negocio. En la v1 la API maneja una sola por negocio
 * (el esquema admite varias): si hubiera más, se usa la más antigua.
 * La consulta pasa por RLS, así que solo ve las del tenant de withTenant().
 */
export async function primaryLocation(tx: Tx): Promise<MerchantLocation> {
  const { rows } = await tx.query("SELECT id, timezone FROM locations ORDER BY created_at, id LIMIT 1");
  if (!rows[0]) throw new MerchantError("not_found", "El negocio no tiene sucursal", "no_location");
  return { id: rows[0].id, timezone: rows[0].timezone };
}

/** Reglas semanales (filas de availability_rules) → horario de la API. */
export function toSchedule(rows: { weekday: number; start_time: string; end_time: string }[]): WeeklySchedule {
  return rows
    .map((r) => ({ weekday: r.weekday, start: r.start_time, end: r.end_time }))
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
}

/** Reemplaza el horario semanal de la sucursal (resourceId null) o de un profesional. */
export async function replaceSchedule(
  tx: Tx,
  a: { tenantId: string; locationId: string; resourceId: string | null; schedule: WeeklySchedule | null },
): Promise<void> {
  await tx.query(
    "DELETE FROM availability_rules WHERE location_id = $1 AND resource_id IS NOT DISTINCT FROM $2",
    [a.locationId, a.resourceId],
  );
  for (const s of a.schedule ?? []) {
    await tx.query(
      `INSERT INTO availability_rules (tenant_id, location_id, resource_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [a.tenantId, a.locationId, a.resourceId, s.weekday, s.start, s.end],
    );
  }
}

export const SCHEDULE_COLUMNS = `weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time`;

export const localDate = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toISODate()!;
export const localTime = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat("HH:mm");
/** Inicio del día local, como instante UTC. */
export const startOfLocalDay = (date: string, zone: string) => DateTime.fromISO(date, { zone }).startOf("day").toJSDate();
export const nextLocalDay = (date: string, zone: string) =>
  DateTime.fromISO(date, { zone }).startOf("day").plus({ days: 1 }).toJSDate();

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}
