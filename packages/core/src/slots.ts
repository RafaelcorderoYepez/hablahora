import { DateTime } from "luxon";
import {
  containedIn,
  intersect,
  Interval,
  overlaps,
  subtract,
  union,
} from "./intervals.js";
import type {
  AvailabilityRule,
  Resource,
  Service,
  Slot,
  SlotQuery,
  SlotResult,
} from "./types.js";

const MIN = 60_000;
const DAY = 86_400_000;

/**
 * Calcula los horarios disponibles para un servicio en un día de servicio.
 *
 * Convención: un "día de servicio" incluye los turnos que abren ese día,
 * aunque crucen medianoche. Un viernes 18:00–02:00 ofrece la 01:00 como
 * parte del viernes, que es como lo piensa un restaurante.
 *
 * Función pura: no toca la base de datos. La garantía final contra doble
 * reserva la da la restricción EXCLUDE de booking_resources al crear el hold.
 */
export function findAvailableSlots(q: SlotQuery): SlotResult {
  const { policy, service, timezone: zone } = q;

  // 1. Tamaño de grupo
  if (policy.maxPartySize != null && q.partySize > policy.maxPartySize) {
    return { slots: [], reason: "party_too_large" };
  }

  // 2. Duración real según el grupo
  const durationMs = serviceDurationMin(service, q.partySize) * MIN;
  const bufferMs = service.bufferAfterMin * MIN;
  const intervalMs = policy.slotIntervalMin * MIN;

  // 3. Recursos candidatos
  const candidates = eligibleResources(q);
  if (candidates.length === 0) {
    const anyFits = q.resources.some(
      (r) =>
        r.isActive &&
        r.kind === service.resourceKind &&
        service.resourceIds.includes(r.id),
    );
    return {
      slots: [],
      reason: anyFits ? "party_too_large" : "no_eligible_resources",
    };
  }

  // 4. Ventanas abiertas por recurso (UTC ms)
  const dayStart = DateTime.fromISO(q.date, { zone }).startOf("day");
  const dayRange: Interval = [
    dayStart.toMillis(),
    dayStart.plus({ days: 1 }).toMillis(),
  ];
  const locationWindow = buildLocationWindow(q, dayRange);
  const windows = new Map<string, Interval[]>();
  for (const r of candidates) {
    windows.set(r.id, buildResourceWindow(q, r, locationWindow, dayRange));
  }
  if ([...windows.values()].every((w) => w.length === 0)) {
    return { slots: [], reason: "closed" };
  }

  // 5. Bloques ocupados por recurso
  const busyByResource = new Map<string, Interval[]>();
  for (const b of q.busy) {
    const list = busyByResource.get(b.resourceId) ?? [];
    list.push([b.start.getTime(), b.end.getTime()]);
    busyByResource.set(b.resourceId, list);
  }

  // 6. Horarios candidatos en la grilla local + ventana de reserva
  const earliest = q.now.getTime() + policy.minLeadTimeMin * MIN;
  const latest = q.now.getTime() + policy.maxAdvanceDays * DAY;
  const gridTimes = new Set<number>();
  for (const w of windows.values()) {
    for (const t of gridStarts(w, policy.slotIntervalMin, zone)) {
      gridTimes.add(t);
    }
  }
  const starts = [...gridTimes]
    .filter((t) => t >= earliest && t <= latest)
    .sort((a, b) => a - b);
  if (starts.length === 0) return { slots: [], reason: "outside_booking_window" };

  // carga del día por recurso, para repartir trabajo entre profesionales
  const load = new Map<string, number>();
  for (const r of candidates) {
    const busy = intersect(busyByResource.get(r.id) ?? [], [dayRange]);
    load.set(r.id, busy.reduce((acc, [a, b]) => acc + (b - a), 0));
  }
  const ranked = [...candidates].sort(
    (a, b) =>
      a.capacityMax - b.capacityMax || // mesa más chica que alcance
      (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || // menos cargado
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      a.id.localeCompare(b.id),
  );

  // 7-8. Validar cada horario y asignar recurso
  const slots: Slot[] = [];
  for (const t of starts) {
    const serviceEnd = t + durationMs;
    const occupied: Interval = [t, serviceEnd + bufferMs];

    if (!passesPacing(q, t, intervalMs)) continue;

    const free = ranked.filter((r) => {
      // el servicio debe terminar dentro del horario de atención;
      // el buffer solo debe no chocar con otras reservas
      if (!containedIn(t, serviceEnd, windows.get(r.id)!)) return false;
      const busy = busyByResource.get(r.id) ?? [];
      return !busy.some((b) => overlaps(b, occupied));
    });
    if (free.length === 0) continue;

    slots.push({
      start: new Date(t),
      end: new Date(serviceEnd),
      localTime: DateTime.fromMillis(t, { zone }).toFormat("HH:mm"),
      resourceId: free[0].id,
      candidateResourceIds: free.map((r) => r.id),
    });
  }

  if (slots.length === 0) return { slots: [], reason: "fully_booked" };

  // 9. Recortar para el chat
  return { slots: pickForConversation(slots, q, dayStart) };
}

// ---------------------------------------------------------------------

export function serviceDurationMin(service: Service, partySize: number): number {
  const rules = [...(service.durationRules ?? [])].sort(
    (a, b) => a.partyMax - b.partyMax,
  );
  const match = rules.find((r) => partySize <= r.partyMax);
  return match ? match.min : service.durationMin;
}

function eligibleResources(q: SlotQuery): Resource[] {
  return q.resources.filter(
    (r) =>
      r.isActive &&
      r.kind === q.service.resourceKind &&
      q.service.resourceIds.includes(r.id) &&
      q.partySize >= r.capacityMin &&
      q.partySize <= r.capacityMax &&
      (q.preferredResourceId == null || r.id === q.preferredResourceId),
  );
}

function isValidOn(rule: AvailabilityRule, date: string): boolean {
  if (rule.validFrom && date < rule.validFrom) return false;
  if (rule.validUntil && date > rule.validUntil) return false;
  return true;
}

/** Convierte una regla semanal en un intervalo absoluto para `date`. */
function ruleToInterval(
  rule: AvailabilityRule,
  date: string,
  zone: string,
): Interval {
  const start = DateTime.fromISO(`${date}T${rule.startTime}`, { zone });
  const endTime = rule.endTime === "24:00" ? "00:00" : rule.endTime;
  let end = DateTime.fromISO(`${date}T${endTime}`, { zone });
  if (endTime <= rule.startTime) {
    // cruza medianoche: misma hora de reloj, día siguiente
    end = DateTime.fromISO(
      `${start.plus({ days: 1 }).toISODate()}T${endTime}`,
      { zone },
    );
  }
  return [start.toMillis(), end.toMillis()];
}

function weekdayOf(date: string, zone: string): number {
  return DateTime.fromISO(date, { zone }).weekday % 7; // luxon: 1=lun..7=dom
}

function rulesFor(
  q: SlotQuery,
  resourceId: string | null,
): Interval[] {
  const wd = weekdayOf(q.date, q.timezone);
  return q.rules
    .filter(
      (r) =>
        r.resourceId === resourceId &&
        r.weekday === wd &&
        isValidOn(r, q.date),
    )
    .map((r) => ruleToInterval(r, q.date, q.timezone));
}

function exceptionsFor(
  q: SlotQuery,
  resourceId: string | null,
  kind: "closed" | "open_override",
): Interval[] {
  return q.exceptions
    .filter((e) => e.resourceId === resourceId && e.kind === kind)
    .map((e) => [e.start.getTime(), e.end.getTime()] as Interval);
}

function buildLocationWindow(q: SlotQuery, dayRange: Interval): Interval[] {
  const base = rulesFor(q, null);
  // las aperturas especiales solo cuentan si empiezan este día de servicio
  const overrides = intersect(exceptionsFor(q, null, "open_override"), [dayRange]);
  return subtract(union(base, overrides), exceptionsFor(q, null, "closed"));
}

function buildResourceWindow(
  q: SlotQuery,
  r: Resource,
  locationWindow: Interval[],
  dayRange: Interval,
): Interval[] {
  const hasOwnSchedule = q.rules.some(
    (rule) => rule.resourceId === r.id && isValidOn(rule, q.date),
  );
  const base = hasOwnSchedule
    ? intersect(rulesFor(q, r.id), locationWindow)
    : locationWindow;
  const overrides = intersect(exceptionsFor(q, r.id, "open_override"), [dayRange]);
  return subtract(union(base, overrides), exceptionsFor(q, r.id, "closed"));
}

/**
 * Inicios alineados a la grilla en hora local (:00, :15, :30...).
 * Se avanza en ms reales, así una hora que no existe (cambio de horario
 * en primavera) simplemente no aparece, y una hora repetida (otoño)
 * aparece dos veces con instantes UTC distintos.
 */
function gridStarts(window: Interval[], intervalMin: number, zone: string): number[] {
  const step = intervalMin * MIN;
  const out: number[] = [];
  for (const [a, b] of window) {
    const local = DateTime.fromMillis(a, { zone });
    const minuteOfDay = local.hour * 60 + local.minute;
    const subMinute = local.second * 1000 + local.millisecond;
    const rem = minuteOfDay % intervalMin;
    const aligned = rem === 0 && subMinute === 0;
    let t = aligned ? a : a - subMinute + (intervalMin - rem) * MIN;
    for (; t < b; t += step) out.push(t);
  }
  return out;
}

function passesPacing(q: SlotQuery, t: number, intervalMs: number): boolean {
  const max = q.policy.pacingMaxCovers;
  if (max == null) return true;
  const seen = new Set<string>();
  let covers = 0;
  for (const b of q.busy) {
    if (seen.has(b.bookingId)) continue; // una reserva puede ocupar varias mesas
    seen.add(b.bookingId);
    const s = b.bookingStartsAt.getTime();
    if (s >= t && s < t + intervalMs) covers += b.partySize;
  }
  return covers + q.partySize <= max;
}

function pickForConversation(
  slots: Slot[],
  q: SlotQuery,
  dayStart: DateTime,
): Slot[] {
  if (q.maxResults == null) return slots;
  if (!q.preferredTime) return slots.slice(0, q.maxResults);
  const target = DateTime.fromISO(`${dayStart.toISODate()}T${q.preferredTime}`, {
    zone: q.timezone,
  }).toMillis();
  return [...slots]
    .sort(
      (a, b) =>
        Math.abs(a.start.getTime() - target) - Math.abs(b.start.getTime() - target) ||
        a.start.getTime() - b.start.getTime(),
    )
    .slice(0, q.maxResults)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Ventanas de atención de un día de servicio, para la agenda: la del local y
 * la de cada recurso (horario propio ∩ local, menos cierres). Instantes UTC (ms).
 * Mismo cálculo que usa findAvailableSlots.
 */
export function dayWindows(
  q: Pick<SlotQuery, "timezone" | "date" | "rules" | "exceptions">,
  resources: Resource[],
): { location: Interval[]; byResource: Map<string, Interval[]> } {
  const query = q as SlotQuery;
  const dayStart = DateTime.fromISO(q.date, { zone: q.timezone }).startOf("day");
  const dayRange: Interval = [dayStart.toMillis(), dayStart.plus({ days: 1 }).toMillis()];
  const location = buildLocationWindow(query, dayRange);
  const byResource = new Map<string, Interval[]>();
  for (const r of resources) byResource.set(r.id, buildResourceWindow(query, r, location, dayRange));
  return { location, byResource };
}
