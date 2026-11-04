import { Button, cn, Input } from "@hablahora/ui";
import { Copy, Moon, Plus, X } from "lucide-react";
import { useI18n } from "../i18n.js";
import { copyToAll, crossesMidnight, dayError, DEFAULT_RANGE, type DayHours } from "../schedule.js";

// la semana empieza el lunes, como se lee un horario
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Horario semanal: un renglón por día, abierto o cerrado, con uno o más tramos.
 * Componente propio (sin librería de calendario). Los errores se muestran por día.
 */
export function ScheduleEditor(props: { id: string; value: DayHours[]; onChange: (days: DayHours[]) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const c = t.cfg.schedule;
  const days = props.value;
  const set = (wd: number, d: DayHours) => props.onChange(days.map((x, i) => (i === wd ? d : x)));

  return (
    <div className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
      {ORDER.map((wd) => {
        const day = days[wd];
        const error = dayError(day);
        const dayId = `${props.id}-${wd}`;
        return (
          <div key={wd} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex flex-none items-center gap-2 pt-2 sm:w-32">
              <input
                id={`${dayId}-open`}
                type="checkbox"
                className="h-4 w-4 accent-[var(--ui-accent)]"
                checked={day.open}
                disabled={props.disabled}
                onChange={(e) => set(wd, { ...day, open: e.target.checked, ranges: day.ranges.length ? day.ranges : [{ ...DEFAULT_RANGE }] })}
              />
              <label htmlFor={`${dayId}-open`} className="font-semibold">
                {t.cfg.days[wd]}
              </label>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {day.open ? (
                day.ranges.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <label className="sr-only" htmlFor={`${dayId}-${i}-start`}>
                      {t.cfg.days[wd]} {c.from}
                    </label>
                    <Input
                      id={`${dayId}-${i}-start`}
                      type="time"
                      step={300}
                      className="w-[8.5rem]"
                      value={r.start}
                      disabled={props.disabled}
                      aria-invalid={!!error}
                      onChange={(e) => set(wd, { ...day, ranges: day.ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })}
                    />
                    <span aria-hidden="true" className="text-muted">
                      –
                    </span>
                    <label className="sr-only" htmlFor={`${dayId}-${i}-end`}>
                      {t.cfg.days[wd]} {c.to}
                    </label>
                    <Input
                      id={`${dayId}-${i}-end`}
                      type="time"
                      step={300}
                      className="w-[8.5rem]"
                      value={r.end}
                      disabled={props.disabled}
                      aria-invalid={!!error}
                      onChange={(e) => set(wd, { ...day, ranges: day.ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })}
                    />
                    {crossesMidnight(r) ? (
                      <span className="inline-flex items-center gap-1 text-xs text-info">
                        <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                        {c.crossesMidnight}
                      </span>
                    ) : null}
                    {day.ranges.length > 1 && !props.disabled ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`${c.removeRange} (${t.cfg.days[wd]})`}
                        onClick={() => set(wd, { ...day, ranges: day.ranges.filter((_, j) => j !== i) })}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="pt-2 text-muted">{c.closed}</p>
              )}
              {error ? (
                <p role="alert" className={cn("text-sm text-danger")}>
                  {error === "overlap" ? c.overlap : c.sameStartEnd}
                </p>
              ) : null}
              {day.open && !props.disabled ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const last = day.ranges.at(-1) ?? DEFAULT_RANGE;
                      set(wd, { ...day, ranges: [...day.ranges, { start: last.end, end: last.end < "22:00" ? "22:00" : "23:59" }] });
                    }}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {c.addRange}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => props.onChange(copyToAll(days, wd))}>
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    {c.copyToAll}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** ¿Hay algún día con error? (para no dejar guardar) */
export const scheduleHasErrors = (days: DayHours[]) => days.some((d) => dayError(d) !== null);
