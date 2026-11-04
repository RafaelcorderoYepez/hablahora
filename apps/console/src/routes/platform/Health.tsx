import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { PlatformHealth } from "@hablahora/contracts";
import { cn } from "@hablahora/ui";
import { PageHeader } from "../../components/AppShell.js";
import { Card, Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { platformHealthQuery } from "../../queries.js";

/** 0.02 → "2 %"; 0.0333 → "3.3 %". */
const pct = (rate: number) => `${Number((rate * 100).toFixed(1))} %`;

/** Salud: latencia y errores del agente, herramientas que fallan y conversaciones sin atender. */
export function PlatformHealthPage() {
  const { t } = useI18n();
  const health = useQuery(platformHealthQuery);
  return (
    <Loaded query={health}>
      {(h) => (
        <>
          <PageHeader title={t.platform.nav.health} subtitle={t.platform.healthSubtitle(h.windowDays)} />
          <Body h={h} />
        </>
      )}
    </Loaded>
  );
}

function Body({ h }: { h: PlatformHealth }) {
  const { t } = useI18n();
  const p = t.platform;
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={p.latency} value={h.agent.p50Ms == null ? "—" : p.ms(h.agent.p50Ms)} hint={`${p.p50} · ${p.p95} ${h.agent.p95Ms == null ? "—" : p.ms(h.agent.p95Ms)}`} extra={p.latencyHint(h.agent.calls)} />
        <Kpi label={p.modelErrors} value={pct(h.agent.errorRate)} hint={p.errorsOf(h.agent.errors, h.agent.calls)} danger={h.agent.errors > 0} />
        <Kpi label={p.toolErrors} value={pct(h.tools.errorRate)} hint={p.errorsOf(h.tools.errors, h.tools.calls)} danger={h.tools.errors > 0} />
        <Kpi label={p.waitingTitle} value={String(h.waiting.length)} hint={p.waitingHint(h.waitThresholdMin)} danger={h.waiting.length > 0} />
      </dl>

      <Card title={p.waitingTitle} hint={p.waitingHint(h.waitThresholdMin)}>
        {h.waiting.length === 0 ? (
          <p className="text-sm text-muted">{p.waitingNone}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {h.waiting.map((w) => (
              <li key={w.conversationId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-semibold">{w.tenantName}</p>
                  {w.reason ? <p className="truncate text-sm text-muted">{w.reason}</p> : null}
                </div>
                <span className="font-semibold tabular-nums text-danger">{p.waitingFor(w.waitingMin)}</span>
                <Link to="/plataforma/soporte" search={{ negocio: w.tenantId }} className="text-sm font-semibold text-brand-text underline-offset-4 hover:underline">
                  {p.openInSupport}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={p.failingTools}>
          {h.tools.failing.length === 0 ? (
            <p className="text-sm text-muted">{p.failingNone}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {h.tools.failing.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 py-2.5">
                  <code className="font-semibold">{f.name}</code>
                  <span className="text-sm text-muted tabular-nums">{p.errorsOf(f.errors, f.calls)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={p.byBusiness}>
          {h.byBusiness.every((b) => b.calls === 0) ? (
            <p className="text-sm text-muted">{p.noCalls}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {h.byBusiness
                .filter((b) => b.calls > 0)
                .map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2.5">
                    <span className="min-w-0 flex-1 truncate font-semibold">{b.name}</span>
                    <span className={cn("text-sm tabular-nums", b.errors > 0 ? "text-danger" : "text-muted")}>
                      {p.errorsOf(b.errors, b.calls)} · {p.p95} {b.p95Ms == null ? "—" : p.ms(b.p95Ms)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>
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
