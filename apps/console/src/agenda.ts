// Cálculos de la agenda del día (sin React): qué horas se muestran, dónde va
// cada reserva y qué partes de cada columna quedan fuera de horario.
// Todo en minutos desde la medianoche local del día (un turno que cruza la
// medianoche pasa de 1440).

export interface MinuteRange {
  start: number;
  end: number;
}

export interface PlacedBlock<T> {
  item: T;
  /** posición vertical en % del alto de la columna */
  top: number;
  height: number;
  /** carril (0…lanes-1) si hay reservas que se pisan en la misma columna */
  lane: number;
  lanes: number;
}

const HOUR = 60;

/**
 * Horas visibles: desde la primera hora con algo (horario o reserva) hasta la
 * última, redondeado a horas enteras. Sin nada ese día, de 9 a 18.
 */
export function visibleRange(day: {
  open: MinuteRange[];
  staff: { windows: MinuteRange[] }[];
  bookings: { startMin: number; endMin: number }[];
}): MinuteRange {
  const all = [
    ...day.open,
    ...day.staff.flatMap((s) => s.windows),
    ...day.bookings.map((b) => ({ start: b.startMin, end: b.endMin })),
  ];
  if (!all.length) return { start: 9 * HOUR, end: 18 * HOUR };
  const start = Math.floor(Math.min(...all.map((r) => r.start)) / HOUR) * HOUR;
  const end = Math.ceil(Math.max(...all.map((r) => r.end)) / HOUR) * HOUR;
  return { start: Math.max(0, start), end: Math.max(end, start + HOUR) };
}

/** Las horas enteras del rango, para la columna de horas. */
export function hourMarks(range: MinuteRange): number[] {
  const marks: number[] = [];
  for (let m = range.start; m < range.end; m += HOUR) marks.push(m);
  return marks;
}

/** Minuto → % del alto de la columna. */
export function toPercent(minute: number, range: MinuteRange): number {
  return ((minute - range.start) / (range.end - range.start)) * 100;
}

/** Lo que queda fuera de las ventanas (para sombrearlo), dentro del rango visible. */
export function offHours(windows: MinuteRange[], range: MinuteRange): MinuteRange[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const gaps: MinuteRange[] = [];
  let cursor = range.start;
  for (const w of sorted) {
    if (w.start > cursor) gaps.push({ start: cursor, end: Math.min(w.start, range.end) });
    cursor = Math.max(cursor, w.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) gaps.push({ start: cursor, end: range.end });
  return gaps.filter((g) => g.end > g.start);
}

/**
 * Posición de cada reserva en su columna. Si dos se pisan (no debería pasar
 * con un mismo profesional, pero un apartado y una reserva vieja podrían),
 * se reparten el ancho en carriles.
 */
export function placeBlocks<T extends { startMin: number; endMin: number }>(items: T[], range: MinuteRange): PlacedBlock<T>[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: PlacedBlock<T>[] = [];
  // grupos de reservas que se pisan entre sí: cada grupo comparte el número de carriles
  let group: PlacedBlock<T>[] = [];
  let groupEnd = -Infinity;
  const laneEnds: number[] = [];
  const closeGroup = () => {
    const lanes = Math.max(1, ...group.map((b) => b.lane + 1));
    for (const b of group) b.lanes = lanes;
    group = [];
    laneEnds.length = 0;
  };
  for (const item of sorted) {
    if (item.startMin >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.endMin;
    groupEnd = Math.max(groupEnd, item.endMin);
    const top = toPercent(Math.max(item.startMin, range.start), range);
    const bottom = toPercent(Math.min(item.endMin, range.end), range);
    const block = { item, top, height: Math.max(bottom - top, 0), lane, lanes: 1 };
    group.push(block);
    placed.push(block);
  }
  closeGroup();
  return placed;
}

/** Punto de la columna (0…1 desde arriba) → minuto, redondeado hacia abajo al paso. */
export function minuteAt(fraction: number, range: MinuteRange, step = 15): number {
  const raw = range.start + Math.min(Math.max(fraction, 0), 1) * (range.end - range.start);
  return Math.min(Math.floor(raw / step) * step, range.end - step);
}

/** 570 → "09:30"; 1470 → "00:30" (del día siguiente). */
export function minuteToTime(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "2026-10-14" + n días. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** La fecha de hoy en la zona del negocio. */
export function todayIn(timezone: string, now = new Date()): string {
  // en-CA da YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Minutos desde la medianoche de hoy en la zona del negocio (para la línea de "ahora"). */
export function minutesNowIn(timezone: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** ¿La reserva ya empezó? (para marcar atendida o no vino) */
export function hasStarted(b: { date: string; time: string }, timezone: string, now = new Date()): boolean {
  const today = todayIn(timezone, now);
  if (b.date !== today) return b.date < today;
  const [h, m] = b.time.split(":").map(Number);
  return h * 60 + m <= minutesNowIn(timezone, now);
}

// ---------------------------------------------------------------------
// Mover arrastrando
// ---------------------------------------------------------------------

/**
 * Inicio de la reserva al soltarla: donde está el puntero menos el punto de la
 * reserva desde donde se tomó, ajustado al paso y sin salirse de las horas visibles.
 */
export function dropStart(pointerMin: number, grabOffsetMin: number, durationMin: number, range: MinuteRange, step = 15): number {
  const raw = Math.round((pointerMin - grabOffsetMin) / step) * step;
  const latest = Math.floor((range.end - durationMin) / step) * step;
  return Math.max(range.start, Math.min(raw, Math.max(range.start, latest)));
}

/** ¿El tramo queda fuera de las ventanas de trabajo (aunque sea en parte)? */
export function isOutside(windows: MinuteRange[], start: number, end: number): boolean {
  return !windows.some((w) => w.start <= start && end <= w.end);
}

/** Minuto del día de la agenda → fecha y hora locales (pasada la medianoche, el día siguiente). */
export function minuteToDateTime(date: string, minute: number): { date: string; time: string } {
  const days = Math.floor(minute / 1440);
  return { date: days ? addDays(date, days) : date, time: minuteToTime(minute) };
}

/** ¿El tramo se cruza con otra reserva de la columna? (el servidor decide al final: sabe de la limpieza) */
export function overlapsOther(bookings: { id: string; startMin: number; endMin: number }[], start: number, end: number, exceptId: string): boolean {
  return bookings.some((b) => b.id !== exceptId && b.startMin < end && start < b.endMin);
}
