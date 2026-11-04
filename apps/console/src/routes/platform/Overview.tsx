import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { PlatformOverview } from "@hablahora/contracts";
import { cn } from "@hablahora/ui";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "../../components/AppShell.js";
import { formatDay } from "../../components/BookingPanel.js";
import { Card, Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { OVERVIEW_PERIODS, type OverviewPeriod } from "../../metrics-periods.js";
import { platformOverviewQuery } from "../../queries.js";

/** Panel general de la plataforma: negocios, conversaciones, reservas y errores por día. */
export function PlatformOverviewPage({ days }: { days: OverviewPeriod }) {
  const { t } = useI18n();
  const p = t.platform;
  const navigate = useNavigate();
  const overview = useQuery(platformOverviewQuery(days));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={p.nav.overview} subtitle={p.overviewSubtitle} />
        <div role="radiogroup" aria-label={p.period} className="flex rounded-lg border border-line bg-surface p-0.5">
          {OVERVIEW_PERIODS.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={days === n}
              onClick={() => void navigate({ to: "/plataforma", search: n === 30 ? {} : { dias: n } })}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent",
                days === n ? "bg-ink text-bg" : "text-muted hover:text-ink",
              )}
            >
              {p.last(n)}
            </button>
          ))}
        </div>
      </div>
      <Loaded query={overview}>{(data) => <Dashboard data={data} />}</Loaded>
    </>
  );
}

function Dashboard({ data }: { data: PlatformOverview }) {
  const { t } = useI18n();
  const p = t.platform;
  const { businesses, totals } = data;
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={p.businessesCount} value={String(businesses.total)} hint={p.activeOf(businesses.active, businesses.total)} extra={p.suspendedClosed(businesses.suspended, businesses.closed)} />
        <Kpi label={p.conversationsKpi} value={String(totals.conversations)} />
        <Kpi label={p.bookingsKpi} value={String(totals.bookings)} />
        <Kpi label={p.errorsKpi} value={String(totals.errors)} hint={p.errorsHint} danger={totals.errors > 0} />
      </dl>
      <Card title={p.conversationsAndBookings}>
        <DayChart data={data} series={[{ key: "conversations", color: "var(--ui-info)" }, { key: "bookings", color: "var(--ui-success)" }]} />
      </Card>
      <Card title={p.errorsPerDay}>
        <DayChart data={data} series={[{ key: "errors", color: "var(--ui-danger)" }]} />
      </Card>
    </div>
  );
}

type SeriesKey = "conversations" | "bookings" | "errors";

function DayChart({ data, series }: { data: PlatformOverview; series: { key: SeriesKey; color: string }[] }) {
  const { t, locale } = useI18n();
  const labels = t.platform.series;
  return (
    <>
      <div className="h-56 w-full" role="img" aria-label={series.map((s) => labels[s.key]).join(", ")}>
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
            <Tooltip cursor={{ fill: "var(--ui-bg)" }} content={(c) => <DayTooltip active={c.active} payload={c.payload} label={c.label} />} />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {labels[s.key]}
          </li>
        ))}
      </ul>
    </>
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
      {payload.map((s) => (
        <p key={String(s.dataKey)} className="flex items-center justify-between gap-4 tabular-nums">
          <span className="flex items-center gap-1.5 text-muted">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {t.platform.series[s.dataKey as SeriesKey]}
          </span>
          {String(s.value)}
        </p>
      ))}
    </div>
  );
}

function Kpi({ label, value, hint, extra, danger }: { label: string; value: string; hint?: string; extra?: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={cn("text-3xl font-display font-bold tabular-nums", danger && "text-danger")}>{value}</dd>
      {hint ? <dd className="text-xs text-muted">{hint}</dd> : null}
      {extra ? <dd className="text-xs text-muted">{extra}</dd> : null}
    </div>
  );
}
