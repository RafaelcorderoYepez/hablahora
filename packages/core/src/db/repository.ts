import { DateTime } from "luxon";
import type { CurrencyCode } from "@hablahora/contracts";
import type {
  AvailabilityException,
  AvailabilityRule,
  BookingPolicy,
  BusyBlock,
  DurationRule,
  Resource,
  Service,
  Weekday,
} from "../types.js";
import type { Tx } from "./tenant.js";

/** Política por defecto si la sucursal no configuró ninguna. */
export const DEFAULT_POLICY: BookingPolicy & {
  cancelCutoffMin: number;
  holdTtlSec: number;
  autoConfirm: boolean;
} = {
  slotIntervalMin: 15,
  minLeadTimeMin: 60,
  maxAdvanceDays: 60,
  maxPartySize: null,
  pacingMaxCovers: null,
  cancelCutoffMin: 120,
  holdTtlSec: 300,
  autoConfirm: true,
};

export type FullPolicy = typeof DEFAULT_POLICY;

export interface ServiceRow extends Service {
  name: string;
  locationId: string;
  /** en la unidad mínima de `currency` (la del negocio) */
  price: number | null;
  currency: CurrencyCode;
  description: string | null;
  nameEn: string | null;
  descriptionEn: string | null;
}

export async function getLocationTimezone(tx: Tx, locationId: string): Promise<string | null> {
  const { rows } = await tx.query("SELECT timezone FROM locations WHERE id = $1", [locationId]);
  return rows[0]?.timezone ?? null;
}

export async function listServices(tx: Tx, locationId: string): Promise<ServiceRow[]> {
  const { rows } = await tx.query(
    `SELECT s.*, t.currency, coalesce(array_agg(sr.resource_id) FILTER (WHERE sr.resource_id IS NOT NULL), '{}') AS resource_ids
       FROM services s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN service_resources sr ON sr.service_id = s.id
      WHERE s.location_id = $1 AND s.is_active
      GROUP BY s.id, t.currency
      ORDER BY s.name`,
    [locationId],
  );
  return rows.map(mapService);
}

export async function getService(tx: Tx, locationId: string, serviceId: string): Promise<ServiceRow | null> {
  const { rows } = await tx.query(
    `SELECT s.*, t.currency, coalesce(array_agg(sr.resource_id) FILTER (WHERE sr.resource_id IS NOT NULL), '{}') AS resource_ids
       FROM services s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN service_resources sr ON sr.service_id = s.id
      WHERE s.id = $1 AND s.location_id = $2 AND s.is_active
      GROUP BY s.id, t.currency`,
    [serviceId, locationId],
  );
  return rows[0] ? mapService(rows[0]) : null;
}

function mapService(r: any): ServiceRow {
  const rules: DurationRule[] = (r.duration_rules ?? []).map((x: any) => ({
    partyMax: x.party_max ?? x.partyMax,
    min: x.min,
  }));
  return {
    id: r.id,
    name: r.name,
    locationId: r.location_id,
    resourceKind: r.resource_kind,
    durationMin: r.duration_min,
    durationRules: rules,
    bufferAfterMin: r.buffer_after_min,
    price: r.price,
    currency: r.currency,
    description: r.description ?? null,
    nameEn: r.name_en ?? null,
    descriptionEn: r.description_en ?? null,
    resourceIds: r.resource_ids,
  };
}

export async function getPolicy(tx: Tx, locationId: string, serviceId: string): Promise<FullPolicy> {
  const { rows } = await tx.query(
    `SELECT * FROM booking_policies
      WHERE location_id = $1 AND (service_id = $2 OR service_id IS NULL)
      ORDER BY service_id NULLS LAST
      LIMIT 1`,
    [locationId, serviceId],
  );
  const p = rows[0];
  if (!p) return { ...DEFAULT_POLICY };
  return {
    slotIntervalMin: p.slot_interval_min,
    minLeadTimeMin: p.min_lead_time_min,
    maxAdvanceDays: p.max_advance_days,
    maxPartySize: p.max_party_size,
    pacingMaxCovers: p.pacing_max_covers,
    cancelCutoffMin: p.cancel_cutoff_min,
    holdTtlSec: p.hold_ttl_sec,
    autoConfirm: p.auto_confirm,
  };
}

export async function getResources(tx: Tx, locationId: string): Promise<(Resource & { name: string })[]> {
  const { rows } = await tx.query(
    "SELECT * FROM resources WHERE location_id = $1",
    [locationId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    capacityMin: r.capacity_min,
    capacityMax: r.capacity_max,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

export async function getRules(tx: Tx, locationId: string): Promise<AvailabilityRule[]> {
  const { rows } = await tx.query(
    `SELECT resource_id, weekday, to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time, valid_from, valid_until
       FROM availability_rules WHERE location_id = $1`,
    [locationId],
  );
  return rows.map((r) => ({
    resourceId: r.resource_id,
    weekday: r.weekday as Weekday,
    startTime: r.start_time,
    endTime: r.end_time,
    validFrom: r.valid_from ?? undefined,
    validUntil: r.valid_until ?? undefined,
  }));
}

/** Rango amplio alrededor del día de servicio (cubre turnos que cruzan medianoche). */
export function serviceDayRange(date: string, timezone: string): [Date, Date] {
  const d = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  return [d.minus({ days: 1 }).toJSDate(), d.plus({ days: 2 }).toJSDate()];
}

export async function getExceptions(
  tx: Tx,
  locationId: string,
  [from, to]: [Date, Date],
): Promise<AvailabilityException[]> {
  const { rows } = await tx.query(
    `SELECT resource_id, lower(period) AS start, upper(period) AS "end", kind
       FROM availability_exceptions
      WHERE location_id = $1 AND period && tstzrange($2, $3)`,
    [locationId, from, to],
  );
  return rows.map((r) => ({ resourceId: r.resource_id, start: r.start, end: r.end, kind: r.kind }));
}

/** Ocupación vigente: reservas activas y holds que no vencieron. */
export async function getBusy(
  tx: Tx,
  locationId: string,
  [from, to]: [Date, Date],
  now: Date,
): Promise<BusyBlock[]> {
  const { rows } = await tx.query(
    `SELECT br.booking_id, br.resource_id, lower(br.period) AS start, upper(br.period) AS "end",
            b.starts_at, b.party_size
       FROM booking_resources br
       JOIN bookings b ON b.id = br.booking_id
      WHERE b.location_id = $1
        AND br.is_active
        AND br.period && tstzrange($2, $3)
        AND NOT (b.status = 'hold' AND b.hold_expires_at < $4)`,
    [locationId, from, to, now],
  );
  return rows.map((r) => ({
    bookingId: r.booking_id,
    resourceId: r.resource_id,
    start: r.start,
    end: r.end,
    bookingStartsAt: r.starts_at,
    partySize: r.party_size,
  }));
}

/**
 * Libera holds vencidos de la sucursal dentro de la transacción actual,
 * para que no bloqueen la restricción EXCLUDE mientras el job no corre.
 */
export async function expireStaleHoldsAt(tx: Tx, locationId: string, now: Date): Promise<void> {
  await tx.query(
    `WITH expired AS (
       UPDATE bookings SET status = 'expired', updated_at = $2
        WHERE location_id = $1 AND status = 'hold' AND hold_expires_at < $2
        RETURNING id)
     UPDATE booking_resources br SET is_active = false
       FROM expired e WHERE br.booking_id = e.id`,
    [locationId, now],
  );
}

/**
 * Cliente con teléfono probado por el canal (WhatsApp). Solo estos se
 * deduplican por teléfono: el mismo número es la misma persona.
 */
export async function upsertVerifiedCustomer(
  tx: Tx,
  tenantId: string,
  phone: string,
  verifiedVia: string,
  name?: string,
): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO customers (tenant_id, phone_e164, name, verified_via)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, phone_e164) WHERE verified_via IS NOT NULL
       DO UPDATE SET name = coalesce(EXCLUDED.name, customers.name)
     RETURNING id`,
    [tenantId, phone, name ?? null, verifiedVia],
  );
  return rows[0].id;
}

export async function findVerifiedCustomer(tx: Tx, phone: string): Promise<string | null> {
  const { rows } = await tx.query(
    "SELECT id FROM customers WHERE phone_e164 = $1 AND verified_via IS NOT NULL",
    [phone],
  );
  return rows[0]?.id ?? null;
}
