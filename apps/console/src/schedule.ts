import type { ScheduleSlot, WeeklySchedule } from "@hablahora/contracts";

/** Un día del editor: abierto o cerrado, con uno o más tramos (horario partido). */
export interface DayHours {
  open: boolean;
  ranges: { start: string; end: string }[];
}

export const DEFAULT_RANGE = { start: "09:00", end: "18:00" };

/** Horario de la API (tramos sueltos) → siete días del editor (0 = domingo). */
export function toDays(schedule: WeeklySchedule): DayHours[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const ranges = schedule
      .filter((s) => s.weekday === weekday)
      .map(({ start, end }) => ({ start, end }))
      .sort((a, b) => a.start.localeCompare(b.start));
    return { open: ranges.length > 0, ranges: ranges.length ? ranges : [{ ...DEFAULT_RANGE }] };
  });
}

/** Siete días del editor → horario de la API (solo los días abiertos). */
export function fromDays(days: DayHours[]): ScheduleSlot[] {
  return days.flatMap((d, weekday) => (d.open ? d.ranges.map((r) => ({ weekday, start: r.start, end: r.end })) : []));
}

/** Un tramo que cierra antes de abrir termina al día siguiente (pertenece al día en que abre). */
export const crossesMidnight = (r: { start: string; end: string }) => r.end < r.start;

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Problema de un día, o null si está bien. */
export function dayError(d: DayHours): "same_start_end" | "overlap" | null {
  if (!d.open) return null;
  if (d.ranges.some((r) => r.start === r.end)) return "same_start_end";
  const spans = d.ranges
    .map((r) => {
      const a = minutes(r.start);
      const b = minutes(r.end);
      return [a, b <= a ? b + 24 * 60 : b] as const;
    })
    .sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) return "overlap";
  return null;
}

/** Copia los tramos de un día a todos los días abiertos. */
export function copyToAll(days: DayHours[], from: number): DayHours[] {
  return days.map((d, i) => (i === from || !d.open ? d : { open: true, ranges: days[from].ranges.map((r) => ({ ...r })) }));
}

const hhmm = (t: string) => t.replace(/^0(\d)/, "$1");

/**
 * Resumen en una línea: "mar–sáb 9:00–19:00". Agrupa días seguidos con los
 * mismos tramos; vacío si no hay días abiertos.
 */
export function summarize(schedule: WeeklySchedule, daysShort: readonly string[]): string {
  const days = toDays(schedule);
  const key = (d: DayHours) => (d.open ? d.ranges.map((r) => `${hhmm(r.start)}–${hhmm(r.end)}`).join(", ") : "");
  // la semana empieza el lunes, como se lee un horario
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups: { days: number[]; hours: string }[] = [];
  for (const wd of order) {
    const hours = key(days[wd]);
    if (!hours) continue;
    const last = groups.at(-1);
    const prev = last?.days.at(-1);
    if (last && last.hours === hours && prev !== undefined && order.indexOf(prev) === order.indexOf(wd) - 1) last.days.push(wd);
    else groups.push({ days: [wd], hours });
  }
  return groups
    .map((g) => {
      const label = g.days.length > 2 ? `${daysShort[g.days[0]]}–${daysShort[g.days.at(-1)!]}` : g.days.map((d) => daysShort[d]).join(", ");
      return `${label} ${g.hours}`;
    })
    .join(" · ");
}
