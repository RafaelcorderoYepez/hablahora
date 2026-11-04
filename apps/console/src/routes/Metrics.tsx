import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Metrics } from "@hablahora/contracts";
import { cn } from "@hablahora/ui";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { addDays, todayIn } from "../agenda.js";
import { PageHeader } from "../components/AppShell.js";
import { formatDay } from "../components/BookingPanel.js";
import { Card, Loaded } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { PERIODS, type Period } from "../metrics-periods.js";
import { businessQuery, metricsQuery } from "../queries.js";


/** Estados en el gráfico, de abajo hacia arriba, con el color de la marca de cada uno. */
const SERIES = [
  { key: "completed", color: "var(--ui-info)" },
  { key: "confirmed", color: "var(--ui-success)" },
  { key: "pending", color: "var(--ui-warning)" },
  { key: "noShow", color: "var(--ui-danger)" },
  { key: "cancelled", color: "var(--ui-line)" },
] as const;

/** Proporción como porcentaje entero; sin base, "—". */
export const percent = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)} %` : "—");

/** Los últimos `days` días hasta hoy, en la zona del negocio. */
export function periodRange(days: number, today: string): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

export function MetricsPage({ period }: { period: Period }) {
  const { t } = useI18n();
  const m = t.metrics;
  const navigate = useNavigate();
  const timezone = useQuery(businessQuery).data?.timezone;
  const range = timezone ? periodRange(period, todayIn(timezone)) : null;
  const metrics = useQuery({ ...metricsQuery(range?.from ?? "", range?.to ?? ""), enabled: !!range });

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={m.title} subtitle={m.subtitle} />
        <div role="radiogroup" aria-label={m.period} className="flex rounded-lg border border-line bg-surface p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={period === p}
              onClick={() => void navigate({ to: "/metricas", search: p === 30 ? {} : { dias: p } })}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent",
                period === p ? "bg-ink text-bg" : "text-muted hover:text-ink",
              )}
            >
              {m.last(p)}
            </button>
          ))}
        </div>
      </div>
      {range ? <Loaded query={metrics}>{(data) => <Dashboard data={data} />}</Loaded> : <p className="text-muted">{t.common.loading}</p>}
    </>
  );
}

function Dashboard({ data }: { data: Metrics }) {
  const { t, locale } = useI18n();
  const m = t.metrics;
  const { totals, chat } = data;
  const all = totals.booked + totals.cancelled;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={m.booked} value={String(totals.booked)} hint={m.bookedHint} />
        <Kpi label={m.cancelled} value={percent(totals.cancelled, all)} hint={m.ofTotal(totals.cancelled, all)} />
        <Kpi label={m.noShow} value={percent(totals.noShow, totals.booked)} hint={m.ofTotal(totals.noShow, totals.booked)} />
        <Kpi label={m.conversion} value={percent(chat.withBooking, chat.conversations)} hint={m.ofTotal(chat.withBooking, chat.conversations)} />
      </dl>

      <Card title={m.perDay} hint={m.perDayHint}>
        <div className="h-64 w-full" role="img" aria-label={m.perDay}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.days} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
              <CartesianGrid vertical={false} stroke="var(--ui-line)" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                minTickGap={16}
                tick={{ fill: "var(--ui-muted)", fontSize: 12 }}
                tickFormatter={(d: string) => formatDay(d, locale, { day: "numeric", month: "short" })}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--ui-muted)", fontSize: 12 }} />
              <Tooltip cursor={{ fill: "var(--ui-bg)" }} content={(p) => <DayTooltip active={p.active} payload={p.payload} label={p.label} />} />
              {SERIES.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} stackId="day" fill={s.color} radius={i === SERIES.length - 1 ? [3, 3, 0, 0] : 0} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {m.status[s.key]}
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={m.chat}>
          <dl className="grid grid-cols-2 gap-4">
            <Stat label={m.conversations} value={String(chat.conversations)} />
            <Stat label={m.withBooking} value={String(chat.withBooking)} />
            <Stat label={m.handedOff} value={String(chat.handedOff)} />
            <Stat
              label={m.teamReply}
              value={chat.medianTeamReplyMin == null ? "—" : m.teamReplyValue(chat.medianTeamReplyMin)}
              hint={chat.medianTeamReplyMin == null ? undefined : m.median}
            />
          </dl>
        </Card>
        <Card title={m.bySource}>
          <Bars rows={data.bySource.map((s) => ({ key: s.source, label: m.source[s.source] ?? s.source, value: s.count }))} empty={m.none} />
        </Card>
        <Card title={m.topServices}>
          <Bars rows={data.topServices.map((s) => ({ key: s.id, label: s.name, value: s.count }))} empty={m.none} />
        </Card>
        <Card title={m.occupancy} hint={m.occupancyHint}>
          <ul className="flex flex-col gap-3">
            {data.occupancy.map((o) => (
              <li key={o.staffId} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-semibold">{o.name}</span>
                  <span className="text-muted tabular-nums">
                    {o.ratio == null ? m.notWorking : `${Math.round(o.ratio * 100)} % · ${m.hours(o.bookedMin, o.availableMin)}`}
                  </span>
                </div>
                <Meter value={o.ratio ?? 0} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function DayTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown; color?: string }[];
  label?: unknown;
}) {
  const { t, locale } = useI18n();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2 text-sm shadow-md">
      <p className="mb-1 font-semibold first-letter:uppercase">{formatDay(String(label), locale, { weekday: "short", day: "numeric", month: "short" })}</p>
      {[...payload].reverse().map((p) => (
        <p key={String(p.dataKey)} className="flex items-center justify-between gap-4 tabular-nums">
          <span className="flex items-center gap-1.5 text-muted">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: p.color }} />
            {t.metrics.status[p.dataKey as keyof typeof t.metrics.status]}
          </span>
          {String(p.value)}
        </p>
      ))}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-3xl font-display font-bold tabular-nums">{value}</dd>
      {hint ? <dd className="text-xs text-muted">{hint}</dd> : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-2xl font-display font-bold tabular-nums">
        {value}
        {hint ? <span className="ml-1.5 text-xs text-muted">{hint}</span> : null}
      </dd>
    </div>
  );
}

function Meter({ value }: { value: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-bg ring-1 ring-line" aria-hidden="true">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

/** Barras horizontales simples (proporción respecto del mayor). */
function Bars({ rows, empty }: { rows: { key: string; label: string; value: number }[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{r.label}</span>
            <span className="font-semibold tabular-nums">{r.value}</span>
          </div>
          <Meter value={max ? r.value / max : 0} />
        </li>
      ))}
    </ul>
  );
}
