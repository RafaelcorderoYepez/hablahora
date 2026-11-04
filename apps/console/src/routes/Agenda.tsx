import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AgendaBooking, DayAgenda, MerchantBooking } from "@hablahora/contracts";
import { Button, cn, ConfirmDialog, Input, Select, Sheet } from "@hablahora/ui";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import {
  addDays,
  dropStart,
  hourMarks,
  isOutside,
  minuteToDateTime,
  minuteAt,
  minutesNowIn,
  minuteToTime,
  overlapsOther,
  offHours,
  placeBlocks,
  toPercent,
  todayIn,
  visibleRange,
  type MinuteRange,
} from "../agenda.js";
import { PageHeader } from "../components/AppShell.js";
import { BookingDetails, formatDay, NewBookingForm, STATUS_TONE, useBookingAction } from "../components/BookingPanel.js";
import { Loaded } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { agendaQuery, businessQuery, write } from "../queries.js";

/** Alto de una hora en la grilla. */
const HOUR_PX = 72;

const BLOCK_TONE: Record<string, string> = {
  success: "bg-success-bg text-success border-success/40",
  warning: "bg-warning-bg text-warning border-warning/50 border-dashed",
  info: "bg-info-bg text-info border-info/40",
  danger: "bg-danger-bg text-danger border-danger/40",
  neutral: "bg-surface text-muted border-line",
};

/** Agenda del día: una columna por profesional, reservas por estado, horario sombreado. */
export function AgendaPage({ date: dateParam }: { date?: string }) {
  const { t, locale } = useI18n();
  const a = t.agenda;
  const navigate = useNavigate();
  const business = useQuery(businessQuery);
  const timezone = business.data?.timezone;
  const today = timezone ? todayIn(timezone) : undefined;
  const date = dateParam ?? today;
  const agenda = useQuery({ ...agendaQuery(date ?? ""), enabled: !!date });
  const [open, setOpen] = useState<MerchantBooking | null>(null);
  const [creating, setCreating] = useState<{ staffId?: string; time?: string } | null>(null);

  const go = (d: string) => void navigate({ to: "/agenda", search: d === today ? {} : { date: d } });

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={a.title} subtitle={a.subtitle} />
        <Button variant="brand" onClick={() => setCreating({})} disabled={!date}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {a.newBooking}
        </Button>
      </div>

      {date ? (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label={a.prevDay} onClick={() => go(addDays(date, -1))}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button variant="outline" onClick={() => today && go(today)} disabled={date === today}>
            {a.today}
          </Button>
          <Button variant="outline" size="icon" aria-label={a.nextDay} onClick={() => go(addDays(date, 1))}>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <h2 className="min-w-0 flex-1 px-2 text-lg font-semibold first-letter:uppercase">{formatDay(date, locale)}</h2>
          <label className="sr-only" htmlFor="agenda-date">
            {a.date}
          </label>
          <Input id="agenda-date" type="date" className="w-auto" value={date} onChange={(e) => e.target.value && go(e.target.value)} />
        </div>
      ) : null}

      {date && timezone ? (
        <Loaded query={agenda}>
          {(day) => (
            <DayGrid
              day={day}
              isToday={day.date === today}
              timezone={timezone}
              onOpen={setOpen}
              onCreate={(staffId, time) => setCreating({ staffId, time })}
            />
          )}
        </Loaded>
      ) : (
        <Loaded query={business}>{() => null}</Loaded>
      )}

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={a.details}>
        {open && timezone ? <BookingDetails key={open.id} booking={open} timezone={timezone} onChange={setOpen} onClose={() => setOpen(null)} /> : null}
      </Sheet>
      <Sheet open={creating !== null} onOpenChange={(o) => !o && setCreating(null)} title={a.newTitle}>
        {creating && date ? (
          <NewBookingForm
            key={`${creating.staffId}-${creating.time}`}
            initial={{ date, ...creating }}
            onDone={(b) => {
              setCreating(null);
              if (b.date !== date) go(b.date);
            }}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function DayGrid({
  day,
  isToday,
  timezone,
  onOpen,
  onCreate,
}: {
  day: DayAgenda;
  isToday: boolean;
  timezone: string;
  onOpen: (b: AgendaBooking) => void;
  onCreate: (staffId: string, time: string) => void;
}) {
  const { t } = useI18n();
  const a = t.agenda;
  const range = visibleRange(day);
  const height = ((range.end - range.start) / 60) * HOUR_PX;
  const [mobileStaff, setMobileStaff] = useState(day.staff[0]?.id ?? "");
  const now = isToday ? minutesNowIn(timezone) : null;
  const { drag, pending, setPending, startDrag, suppressClick } = useDragMove(day, range);
  const pendingStaff = pending ? day.staff.find((s) => s.id === pending.staffId) : undefined;
  const target = pending ? minuteToDateTime(day.date, pending.start) : null;
  const move = useBookingAction(
    (m: { bookingId: string; date: string; time: string; staffId: string; outsideHours: boolean }) =>
      write<MerchantBooking>("POST", `/api/merchant/bookings/${m.bookingId}/reschedule`, {
        date: m.date,
        time: m.time,
        staffId: m.staffId,
        outsideHours: m.outsideHours,
      }),
    a.moved,
  );

  if (day.staff.length === 0) return <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{a.noStaff}</p>;

  return (
    <div className="flex flex-col gap-4">
      {day.open.length === 0 ? <p className="rounded-lg bg-warning-bg px-4 py-3 text-sm text-warning">{a.closed}</p> : null}
      {/* en el teléfono, un profesional a la vez */}
      <div className="md:hidden">
        <label htmlFor="agenda-staff" className="mb-1.5 block text-sm font-semibold">
          {a.showStaff}
        </label>
        <Select id="agenda-staff" value={mobileStaff} onChange={(e) => setMobileStaff(e.target.value)}>
          {day.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <div className="flex min-w-full">
          {/* columna de horas */}
          <div className="sticky left-0 z-10 w-14 flex-none border-r border-line bg-surface">
            <div className="h-11 border-b border-line" />
            <div className="relative" style={{ height }}>
              {hourMarks(range).map((m) => (
                <span
                  key={m}
                  className="absolute right-2 -translate-y-1/2 text-xs text-muted tabular-nums first:translate-y-0"
                  style={{ top: `${toPercent(m, range)}%` }}
                >
                  {minuteToTime(m)}
                </span>
              ))}
            </div>
          </div>
          {day.staff.map((s) => (
            <StaffColumn
              key={s.id}
              name={s.name}
              windows={s.windows}
              bookings={day.bookings.filter((b) => b.staff?.id === s.id)}
              range={range}
              height={height}
              now={now}
              className={cn(s.id !== mobileStaff && "hidden md:flex")}
              staffId={s.id}
              drag={drag}
              onGrab={startDrag}
              onOpen={(b) => !suppressClick.current && onOpen(b)}
              onCreate={(time) => !suppressClick.current && onCreate(s.id, time)}
            />
          ))}
        </div>
      </div>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending && pendingStaff && target ? a.dragTitle(pendingStaff.name, target.time) : ""}
        description={
          pending && pendingStaff
            ? [a.dragBody(pending.booking.customer?.name ?? "—", pending.booking.service.name), pending.outside ? a.dragOutside(pendingStaff.name) : "", a.notifies]
                .filter(Boolean)
                .join(" ")
            : ""
        }
        confirmLabel={a.move}
        cancelLabel={a.keep}
        onConfirm={() => {
          if (pending && target) {
            move.mutate({ bookingId: pending.booking.id, ...target, staffId: pending.staffId, outsideHours: pending.outside });
          }
          setPending(null);
        }}
      />
    </div>
  );
}

interface Drag {
  booking: AgendaBooking;
  /** minutos entre el inicio de la reserva y el punto donde se tomó */
  grabOffsetMin: number;
  staffId: string;
  start: number;
  moved: boolean;
  /** cae encima de otra reserva de ese profesional */
  blocked: boolean;
}

/**
 * Mover arrastrando (mouse o lápiz; en pantallas táctiles queda el botón Mover).
 * Mientras se arrastra, una silueta muestra dónde caería; al soltar en otro
 * lugar se pide confirmación, porque se le avisa al cliente.
 */
function useDragMove(day: DayAgenda, range: MinuteRange) {
  const { t } = useI18n();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pending, setPending] = useState<{ booking: AgendaBooking; staffId: string; start: number; outside: boolean } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // tras soltar, el navegador manda un clic: no debe abrir el panel ni crear una reserva
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const minuteIn = (el: Element, clientY: number) => {
    const rect = el.getBoundingClientRect();
    return range.start + ((clientY - rect.top) / rect.height) * (range.end - range.start);
  };

  const startDrag = (e: ReactPointerEvent<HTMLElement>, booking: AgendaBooking, staffId: string) => {
    if (e.button !== 0 || e.pointerType === "touch" || !["pending", "confirmed"].includes(booking.status)) return;
    const column = e.currentTarget.closest("[data-drop-staff]");
    if (!column) return;
    const origin = { x: e.clientX, y: e.clientY };
    const duration = booking.endMin - booking.startMin;
    dragRef.current = {
      booking,
      grabOffsetMin: minuteIn(column, e.clientY) - booking.startMin,
      staffId,
      start: booking.startMin,
      moved: false,
      blocked: false,
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 5) return;
      const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el instanceof HTMLElement && el.dataset.dropStaff);
      const staffId = over instanceof HTMLElement ? over.dataset.dropStaff! : d.staffId;
      const start = over ? dropStart(minuteIn(over, ev.clientY), d.grabOffsetMin, duration, range) : d.start;
      const others = day.bookings.filter((b) => b.staff?.id === staffId);
      const next: Drag = { ...d, moved: true, staffId, start, blocked: overlapsOther(others, start, start + duration, booking.id) };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      cleanup.current?.();
      dragRef.current = null;
      setDrag(null);
      if (!d?.moved) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (d.staffId === booking.staff?.id && d.start === booking.startMin) return;
      if (d.blocked) return void toast.error(t.agenda.dragBusy);
      const windows = day.staff.find((s) => s.id === d.staffId)?.windows ?? [];
      setPending({ booking, staffId: d.staffId, start: d.start, outside: isOutside(windows, d.start, d.start + duration) });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      cleanup.current?.();
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    cleanup.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      cleanup.current = null;
    };
  };

  return { drag: drag?.moved ? drag : null, pending, setPending, startDrag, suppressClick };
}

function StaffColumn({
  name,
  windows,
  bookings,
  range,
  height,
  now,
  className,
  staffId,
  drag,
  onGrab,
  onOpen,
  onCreate,
}: {
  name: string;
  windows: MinuteRange[];
  bookings: AgendaBooking[];
  range: MinuteRange;
  height: number;
  now: number | null;
  className?: string;
  staffId: string;
  drag: Drag | null;
  onGrab: (e: ReactPointerEvent<HTMLElement>, b: AgendaBooking, staffId: string) => void;
  onOpen: (b: AgendaBooking) => void;
  onCreate: (time: string) => void;
}) {
  const { t } = useI18n();
  const a = t.agenda;
  return (
    <div className={cn("flex min-w-44 flex-1 flex-col border-r border-line last:border-r-0", className)}>
      <div className="flex h-11 items-center justify-center border-b border-line px-2 font-semibold">
        <span className="truncate">{name}</span>
      </div>
      <div
        className="relative cursor-copy"
        data-drop-staff={staffId}
        style={{ height }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onCreate(minuteToTime(minuteAt((e.clientY - rect.top) / rect.height, range)));
        }}
      >
        {/* líneas de cada hora */}
        {hourMarks(range).map((m) => (
          <div key={m} aria-hidden="true" className="absolute inset-x-0 border-t border-line/70" style={{ top: `${toPercent(m, range)}%` }} />
        ))}
        {/* fuera de horario, sombreado */}
        {offHours(windows, range).map((g) => (
          <div
            key={g.start}
            title={a.offHours}
            className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--ui-line)_6px_7px)] bg-bg/60"
            style={{ top: `${toPercent(g.start, range)}%`, height: `${toPercent(g.end, range) - toPercent(g.start, range)}%` }}
          />
        ))}
        {now !== null && now >= range.start && now <= range.end ? (
          <div
            aria-label={a.now}
            className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-brand"
            style={{ top: `${toPercent(now, range)}%` }}
          />
        ) : null}
        {drag?.staffId === staffId ? (
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-[3px] z-30 flex flex-col rounded-lg border-2 border-dashed px-2 py-1 text-xs font-semibold tabular-nums",
              drag.blocked ? "border-danger bg-danger-bg/90 text-danger" : "border-ink bg-raised/80",
            )}
            style={{
              top: `${toPercent(drag.start, range)}%`,
              height: `calc(${toPercent(drag.start + drag.booking.endMin - drag.booking.startMin, range) - toPercent(drag.start, range)}% - 2px)`,
            }}
          >
            {minuteToTime(drag.start)}–{minuteToTime(drag.start + drag.booking.endMin - drag.booking.startMin)}
            <span className="truncate font-normal">{drag.blocked ? a.dragBlocked : drag.booking.customer?.name}</span>
          </div>
        ) : null}
        {placeBlocks(bookings, range).map(({ item: b, top, height: h, lane, lanes }) => (
          <button
            key={b.id}
            type="button"
            onPointerDown={(e) => onGrab(e, b, staffId)}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(b);
            }}
            className={cn(
              "absolute z-10 flex touch-manipulation flex-col overflow-hidden rounded-lg border px-2 py-1 text-left text-xs leading-tight shadow-sm select-none focus-visible:outline-2 focus-visible:outline-accent",
              BLOCK_TONE[STATUS_TONE[b.status] ?? "neutral"],
              ["pending", "confirmed"].includes(b.status) && "md:cursor-grab",
              drag?.booking.id === b.id && "opacity-40",
            )}
            style={{
              top: `${top}%`,
              height: `calc(${h}% - 2px)`,
              left: `calc(${(lane / lanes) * 100}% + 3px)`,
              width: `calc(${100 / lanes}% - 6px)`,
            }}
          >
            <span className="font-semibold tabular-nums">
              {b.time}–{b.endTime}
            </span>
            <span className="truncate font-semibold text-ink">{b.customer?.name ?? "—"}</span>
            <span className="truncate">
              {b.service.name}
              {b.status !== "confirmed" ? ` · ${a.status[b.status] ?? b.status}` : ""}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
