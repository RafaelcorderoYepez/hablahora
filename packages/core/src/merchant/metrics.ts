import type { Metrics, MetricsQuery } from "@hablahora/contracts";
import { DateTime } from "luxon";
import { getExceptions, getResources, getRules } from "../db/repository.js";
import type { Tx } from "../db/tenant.js";
import { dayWindows } from "../slots.js";
import { nextLocalDay, primaryLocation, startOfLocalDay } from "./common.js";

/**
 * Métricas del negocio entre dos fechas locales (inclusive): reservas por día
 * y estado, por origen, servicios más pedidos, el chat (conversaciones, cuántas
 * terminaron en reserva, cuántas pasaron al equipo y cuánto tardó en responder)
 * y ocupación de cada profesional. Sin costos del modelo (son de la plataforma).
 */
export async function getMetrics(tx: Tx, q: MetricsQuery): Promise<Metrics> {
  const loc = await primaryLocation(tx);
  const from = startOfLocalDay(q.from, loc.timezone);
  const to = nextLocalDay(q.to, loc.timezone);

  // reservas que empiezan en el período (sin apartados ni vencidas)
  const byDay = await tx.query(
    `SELECT to_char(b.starts_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date, b.status, count(*)::int AS n
       FROM bookings b
      WHERE b.location_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 AND b.status NOT IN ('hold', 'expired')
      GROUP BY 1, 2`,
    [loc.id, from, to, loc.timezone],
  );
  const days = new Map<string, Metrics["days"][number]>();
  for (let d = DateTime.fromISO(q.from); d.toISODate()! <= q.to; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    days.set(date, { date, pending: 0, confirmed: 0, completed: 0, noShow: 0, cancelled: 0 });
  }
  const totals = { pending: 0, confirmed: 0, completed: 0, noShow: 0, cancelled: 0 };
  for (const r of byDay.rows) {
    const key = ({ pending: "pending", confirmed: "confirmed", seated: "confirmed", completed: "completed", no_show: "noShow", cancelled: "cancelled" } as const)[
      r.status as "pending"
    ];
    if (!key) continue;
    const day = days.get(r.date);
    if (day) day[key] += r.n;
    totals[key] += r.n;
  }

  const bySource = await tx.query(
    `SELECT b.source, count(*)::int AS n FROM bookings b
      WHERE b.location_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 AND b.status NOT IN ('hold', 'expired', 'cancelled')
      GROUP BY 1 ORDER BY 2 DESC`,
    [loc.id, from, to],
  );

  const services = await tx.query(
    `SELECT s.id, s.name, count(*)::int AS n FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.location_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 AND b.status NOT IN ('hold', 'expired', 'cancelled')
      GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 5`,
    [loc.id, from, to],
  );

  // conversaciones con algún mensaje del cliente, empezadas en el período
  const chat = await tx.query(
    `WITH conv AS (
       SELECT c.id, c.handoff_at,
              EXISTS (SELECT 1 FROM bookings b WHERE b.conversation_id = c.id AND b.status NOT IN ('hold', 'expired')) AS booked,
              (SELECT min(m.created_at) FROM conversation_messages m
                WHERE m.conversation_id = c.id AND m.author = 'staff' AND m.created_at >= c.handoff_at) AS first_staff_reply
         FROM conversations c
        WHERE c.location_id = $1 AND c.created_at >= $2 AND c.created_at < $3
          AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.author = 'customer')
     )
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE booked)::int AS with_booking,
            count(*) FILTER (WHERE handoff_at IS NOT NULL)::int AS handed_off,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_staff_reply - handoff_at))
              FILTER (WHERE first_staff_reply IS NOT NULL) AS median_reply_sec
       FROM conv`,
    [loc.id, from, to],
  );
  const c = chat.rows[0];

  return {
    from: q.from,
    to: q.to,
    totals: { ...totals, booked: totals.pending + totals.confirmed + totals.completed + totals.noShow },
    days: [...days.values()],
    bySource: bySource.rows.map((r) => ({ source: r.source, count: r.n })),
    topServices: services.rows.map((r) => ({ id: r.id, name: r.name, count: r.n })),
    chat: {
      conversations: c.total,
      withBooking: c.with_booking,
      handedOff: c.handed_off,
      medianTeamReplyMin: c.median_reply_sec == null ? null : Math.round(Number(c.median_reply_sec) / 60),
    },
    occupancy: await occupancy(tx, loc, q, from, to),
  };
}

/** Minutos reservados sobre minutos de horario de cada profesional activo, en el período. */
async function occupancy(tx: Tx, loc: { id: string; timezone: string }, q: MetricsQuery, from: Date, to: Date): Promise<Metrics["occupancy"]> {
  const staff = (await getResources(tx, loc.id))
    .filter((r) => r.kind === "staff" && r.isActive)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  const rules = await getRules(tx, loc.id);
  const exceptions = await getExceptions(tx, loc.id, [new Date(from.getTime() - 86_400_000), new Date(to.getTime() + 86_400_000)]);
  const available = new Map(staff.map((s) => [s.id, 0]));
  for (let d = DateTime.fromISO(q.from); d.toISODate()! <= q.to; d = d.plus({ days: 1 })) {
    const { byResource } = dayWindows({ timezone: loc.timezone, date: d.toISODate()!, rules, exceptions }, staff);
    for (const s of staff) {
      const minutes = (byResource.get(s.id) ?? []).reduce((sum, [a, b]) => sum + (b - a) / 60_000, 0);
      available.set(s.id, available.get(s.id)! + minutes);
    }
  }
  // tiempo de atención (sin la limpieza), de las reservas que ocupan el horario
  const booked = await tx.query(
    `SELECT br.resource_id, sum(extract(epoch FROM b.ends_at - b.starts_at) / 60)::int AS minutes
       FROM bookings b
       JOIN LATERAL (SELECT resource_id FROM booking_resources x WHERE x.booking_id = b.id ORDER BY x.is_active DESC LIMIT 1) br ON true
      WHERE b.location_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3
        AND b.status IN ('pending', 'confirmed', 'seated', 'completed', 'no_show')
      GROUP BY 1`,
    [loc.id, from, to],
  );
  const bookedBy = new Map(booked.rows.map((r) => [r.resource_id, r.minutes as number]));
  return staff.map((s) => {
    const availableMin = Math.round(available.get(s.id)!);
    const bookedMin = bookedBy.get(s.id) ?? 0;
    return { staffId: s.id, name: s.name, bookedMin, availableMin, ratio: availableMin > 0 ? Math.min(bookedMin / availableMin, 1) : null };
  });
}
