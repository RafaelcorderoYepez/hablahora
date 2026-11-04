import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge, Button, cn } from "@hablahora/ui";
import { CircleCheck, CircleDashed } from "lucide-react";
import { PageHeader } from "../components/AppShell.js";
import { useI18n } from "../i18n.js";
import { addDays, todayIn } from "../agenda.js";
import { bookingsQuery, businessQuery, meQuery, readinessQuery } from "../queries.js";

const CHECK_LINKS: Record<string, string> = {
  services: "/servicios",
  hours: "/horario",
  web_chat_slug: "/chat-web",
  agent_knowledge: "/agente",
};

/** Inicio: qué falta para que el chat atienda. */
export function HomePage() {
  const { t } = useI18n();
  const me = useQuery(meQuery).data!;
  const readiness = useQuery(readinessQuery);
  const admin = me.business?.role === "merchant_admin";

  return (
    <>
      <PageHeader title={t.home.greeting(me.user.name)} />
      <PendingNotice />
      {readiness.isPending ? (
        <p className="text-muted">{t.common.loading}</p>
      ) : readiness.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-danger">{t.common.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void readiness.refetch()}>
            {t.common.retry}
          </Button>
        </div>
      ) : (
        <section aria-labelledby="readiness-title" className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6">
          <div className="flex flex-col gap-1.5">
            <h2 id="readiness-title" className="text-xl font-semibold">
              {readiness.data.ready ? t.home.ready : t.home.notReady}
            </h2>
            <p className="text-muted">{readiness.data.ready ? t.home.readyBody : t.home.notReadyBody}</p>
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {readiness.data.checks.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center gap-3 py-3">
                {c.ok ? (
                  <CircleCheck className="h-5 w-5 flex-none text-success" aria-hidden="true" />
                ) : (
                  <CircleDashed className={cn("h-5 w-5 flex-none", c.required ? "text-warning" : "text-muted")} aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">{t.home.checks[c.key] ?? c.key}</span>
                {!c.required ? <Badge>{t.home.recommended}</Badge> : null}
                <Badge tone={c.ok ? "success" : c.required ? "warning" : "neutral"}>{c.ok ? t.home.done : t.home.pending}</Badge>
                {!c.ok && admin ? (
                  <Link to={CHECK_LINKS[c.key]} className="text-sm font-semibold text-brand-text underline-offset-4 hover:underline">
                    {t.home.configure}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Reservas por confirmar desde hoy (las que el negocio debe revisar). */
function PendingNotice() {
  const { t } = useI18n();
  const timezone = useQuery(businessQuery).data?.timezone;
  const from = timezone ? todayIn(timezone) : "";
  const pending = useQuery({ ...bookingsQuery({ from, to: from && addDays(from, 62), status: "pending" }), enabled: !!from });
  const n = pending.data?.items.length ?? 0;
  if (!n) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl bg-warning-bg px-5 py-4 text-warning">
      <p className="min-w-0 flex-1 font-semibold">{t.agenda.pendingNotice(n)}</p>
      <Link
        to="/reservas"
        search={{ from, to: addDays(from, 62), status: "pending" }}
        className="text-sm font-semibold underline underline-offset-4"
      >
        {t.agenda.review}
      </Link>
    </div>
  );
}
