import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Badge, Button, cn } from "@hablahora/ui";
import { PageHeader } from "../components/AppShell.js";
import { Loaded } from "../components/common.js";
import { useI18n, type Locale } from "../i18n.js";
import { businessQuery, conversationsQuery, handoffCountQuery } from "../queries.js";

/** "12 oct, 10:32" en la zona del negocio. */
export function formatMoment(iso: string, locale: Locale, timezone?: string) {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

/** Conversaciones, la más reciente primero; filtro de las que esperan al equipo. */
export function ConversationsPage({ waiting }: { waiting: boolean }) {
  const { t, locale } = useI18n();
  const c = t.inbox;
  const navigate = useNavigate();
  const timezone = useQuery(businessQuery).data?.timezone;
  const count = useQuery(handoffCountQuery).data?.count ?? 0;
  const list = useInfiniteQuery(conversationsQuery(waiting));

  const tabs = [
    { key: false, label: c.all },
    { key: true, label: c.waiting, badge: count },
  ];

  return (
    <>
      <PageHeader title={c.title} subtitle={c.subtitle} />
      <div role="tablist" aria-label={c.title} className="mb-6 flex gap-1 border-b border-line">
        {tabs.map((tab) => (
          <button
            key={String(tab.key)}
            type="button"
            role="tab"
            aria-selected={waiting === tab.key}
            onClick={() => void navigate({ to: "/conversaciones", search: tab.key ? { espera: true } : {} })}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold",
              waiting === tab.key ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {tab.label}
            {tab.badge ? <span className="rounded-full bg-brand px-1.5 text-xs text-white tabular-nums">{tab.badge}</span> : null}
          </button>
        ))}
      </div>

      <Loaded query={list}>
        {(data) => {
          const items = data.pages.flatMap((p) => p.items);
          if (items.length === 0) {
            return <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{waiting ? c.emptyWaiting : c.empty}</p>;
          }
          return (
            <div className="flex flex-col gap-4">
              <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
                {items.map((conv) => (
                  <li key={conv.id}>
                    <Link
                      to="/conversaciones/$id"
                      params={{ id: conv.id }}
                      className="flex flex-col gap-1 px-4 py-3 hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="min-w-0 flex-1 truncate font-semibold">{conv.customer?.name ?? c.anonymous}</span>
                        {conv.handoff ? <Badge tone="warning">{c.needsTeam}</Badge> : null}
                        {conv.bookingsCount > 0 ? <Badge tone="success">{c.bookings(conv.bookingsCount)}</Badge> : null}
                        <span className="text-sm text-muted tabular-nums">{formatMoment(conv.updatedAt, locale, timezone)}</span>
                      </span>
                      <span className="line-clamp-2 text-sm text-muted">{conv.lastMessage ?? "—"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              {list.hasNextPage ? (
                <Button variant="outline" className="self-center" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {c.loadMore}
                </Button>
              ) : null}
            </div>
          );
        }}
      </Loaded>
    </>
  );
}
