import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { PlatformUsage } from "@hablahora/contracts";
import { Badge, Select } from "@hablahora/ui";
import { PageHeader } from "../../components/AppShell.js";
import { Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { platformUsageQuery } from "../../queries.js";
import { compact, usd } from "./common.js";

/** Los últimos meses, el actual primero ("2026-10", "2026-09"…). */
export function recentMonths(now: Date, count = 6): string[] {
  const out: string[] = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    if (--m < 0) {
      m = 11;
      y--;
    }
  }
  return out;
}

/** Uso y costo del modelo por negocio, contra el plan. */
export function PlatformUsagePage({ month }: { month?: string }) {
  const { t, locale } = useI18n();
  const p = t.platform;
  const navigate = useNavigate();
  const months = recentMonths(new Date());
  const selected = month && months.includes(month) ? month : months[0];
  const usage = useQuery(platformUsageQuery(selected));
  const label = (m: string) => new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T12:00:00Z`));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={p.nav.usage} subtitle={p.usageSubtitle} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="usage-month" className="text-sm font-semibold">
            {p.month}
          </label>
          <Select id="usage-month" value={selected} onChange={(e) => void navigate({ to: "/plataforma/uso", search: e.target.value === months[0] ? {} : { mes: e.target.value } })}>
            {months.map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Loaded query={usage}>{(data) => <UsageTable data={data} />}</Loaded>
    </>
  );
}

function UsageTable({ data }: { data: PlatformUsage }) {
  const { t, locale } = useI18n();
  const p = t.platform;
  const unpriced = data.businesses.reduce((s, b) => s + b.unpricedCalls, 0);
  const active = data.businesses.filter((b) => b.llmCalls > 0 || b.conversations > 0);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={p.totalCost} value={usd(data.totals.costUsd, locale)} hint={p.costHint} />
        <Kpi label={p.conversationsKpi} value={String(data.totals.conversations)} />
        <Kpi label={p.llmCalls} value={String(data.totals.llmCalls)} />
        <Kpi
          label={p.costPerConversation}
          value={data.totals.conversations > 0 ? usd(data.totals.costUsd / data.totals.conversations, locale) : "—"}
        />
      </dl>
      {unpriced > 0 ? <p className="rounded-lg bg-warning-bg px-4 py-3 text-sm text-warning">{p.unpriced(unpriced)}</p> : null}
      {active.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{p.noUsage}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">{p.business}</th>
                <th className="px-4 py-3 font-semibold">{p.conversationsKpi}</th>
                <th className="px-4 py-3 font-semibold">{p.llmCalls}</th>
                <th className="px-4 py-3 font-semibold">{p.tokens}</th>
                <th className="px-4 py-3 text-right font-semibold">{p.cost}</th>
                <th className="px-4 py-3 text-right font-semibold">{p.costPerConversation}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {active.map((b) => (
                <tr key={b.id}>
                  <td className="px-4 py-3">
                    <span className="block font-semibold">{b.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {b.plan.name}
                      {b.status !== "active" ? <Badge tone="warning">{p.status[b.status]}</Badge> : null}
                      {b.unpricedCalls > 0 ? <Badge tone="warning">{p.unpriced(b.unpricedCalls)}</Badge> : null}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="block">{b.maxConversationsPerMonth == null ? b.conversations : `${b.conversations} / ${b.maxConversationsPerMonth}`}</span>
                    {b.maxConversationsPerMonth != null ? <Bar value={b.conversations / b.maxConversationsPerMonth} /> : null}
                  </td>
                  <td className="px-4 py-3">{b.llmCalls}</td>
                  <td className="px-4 py-3 text-xs text-muted">
                    <span className="block">
                      {compact(b.inputTokens)} {p.tokensIn} · {compact(b.outputTokens)} {p.tokensOut}
                    </span>
                    <span className="block">
                      {compact(b.cacheReadTokens + b.cacheWriteTokens)} {p.tokensCache}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{usd(b.costUsd, locale)}</td>
                  <td className="px-4 py-3 text-right">{b.costPerConversationUsd == null ? "—" : usd(b.costPerConversationUsd, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Uso contra el límite: rojo desde el 100 %, ámbar desde el 80 %. */
function Bar({ value }: { value: number }) {
  const color = value >= 1 ? "var(--ui-danger)" : value >= 0.8 ? "var(--ui-warning)" : "var(--ui-accent)";
  return (
    <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-bg ring-1 ring-line" aria-hidden="true">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.round(value * 100))}%`, background: color }} />
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
