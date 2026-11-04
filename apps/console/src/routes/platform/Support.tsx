import { useMutation, useQuery } from "@tanstack/react-query";
import type { ConversationDetail, ConversationPage, ConversationSummary } from "@hablahora/contracts";
import { Badge, Button, cn, Field, Select, Textarea } from "@hablahora/ui";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorText } from "../../api.js";
import { PageHeader } from "../../components/AppShell.js";
import { Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { platformBusinessesQuery, supportLogQuery, write } from "../../queries.js";
import { Bubble, ContextNote, timeline, ToolCard } from "../Conversation.js";
import { formatMoment } from "../Conversations.js";

const MIN_REASON = 5;

/** Soporte: ver las conversaciones de un negocio (solo lectura), siempre con un motivo que queda registrado. */
export function PlatformSupportPage({ businessId }: { businessId?: string }) {
  const { t } = useI18n();
  const p = t.platform;
  const [tab, setTab] = useState<"view" | "log">("view");

  return (
    <>
      <PageHeader title={p.nav.support} subtitle={p.supportSubtitle} />
      <div role="tablist" aria-label={p.nav.support} className="mb-6 flex gap-1 border-b border-line">
        {(["view", "log"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-semibold",
              tab === k ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {p.tabs[k]}
          </button>
        ))}
      </div>
      {tab === "view" ? <Viewer initialBusinessId={businessId} /> : <AccessLog />}
    </>
  );
}

interface Access {
  businessId: string;
  reason: string;
  handoff: boolean;
}

function Viewer({ initialBusinessId }: { initialBusinessId?: string }) {
  const { t, locale } = useI18n();
  const p = t.platform;
  const businesses = useQuery(platformBusinessesQuery);
  const [businessId, setBusinessId] = useState(initialBusinessId ?? "");
  const [reason, setReason] = useState("");
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const [access, setAccess] = useState<Access | null>(null);
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [opened, setOpened] = useState<ConversationDetail | null>(null);

  const url = (a: Access) => `/api/platform/support/businesses/${a.businessId}/conversations`;
  const fail = (err: unknown) => toast.error(errorText(err, p.errors, t.common.genericError));

  // el listado se pide con POST (no se repite solo): abrirlo es un acceso que queda registrado
  const list = useMutation({
    mutationFn: (a: { access: Access; cursor?: string }) =>
      write<ConversationPage>("POST", url(a.access), {
        reason: a.access.reason,
        ...(a.access.handoff ? { handoff: true } : {}),
        ...(a.cursor ? { cursor: a.cursor } : {}),
      }),
    onSuccess: (page, a) => {
      setItems((cur) => (a.cursor ? [...cur, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setAccess(a.access);
      setOpened(null);
    },
    onError: fail,
  });
  const open = useMutation({
    mutationFn: (conversationId: string) => write<ConversationDetail>("POST", `${url(access!)}/${conversationId}`, { reason: access!.reason }),
    onSuccess: setOpened,
    onError: fail,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessId) return setError(p.pickBusiness);
    if (reason.trim().length < MIN_REASON) return setError(p.reasonShort);
    setError(undefined);
    list.mutate({ access: { businessId, reason: reason.trim(), handoff: onlyWaiting } });
  };

  if (opened && access) {
    return <ReadOnlyConversation detail={opened} onBack={() => setOpened(null)} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5" onSubmit={submit} noValidate>
        <Field id="support-business" label={p.business}>
          <Select id="support-business" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
            <option value="">{p.pickBusiness}</option>
            {(businesses.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="support-reason" label={p.reason} hint={p.reasonHint} error={error && businessId ? error : undefined}>
          <Textarea id="support-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && !businessId ? <p className="text-sm text-danger">{error}</p> : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--ui-accent)]" checked={onlyWaiting} onChange={(e) => setOnlyWaiting(e.target.checked)} />
          {p.onlyWaiting}
        </label>
        <Button type="submit" variant="brand" className="self-start" disabled={list.isPending}>
          {p.open}
        </Button>
      </form>

      {access ? (
        items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{p.supportEmpty}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">{p.readOnlyNote}</p>
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={open.isPending}
                    onClick={() => open.mutate(c.id)}
                    className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="min-w-0 flex-1 truncate font-semibold">{c.customer?.name ?? p.noName}</span>
                      {c.handoff ? <Badge tone="warning">{t.inbox.needsTeam}</Badge> : null}
                      <span className="text-sm text-muted tabular-nums">{formatMoment(c.updatedAt, locale)}</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-muted">{c.lastMessage ?? "—"}</span>
                  </button>
                </li>
              ))}
            </ul>
            {nextCursor ? (
              <Button variant="outline" className="self-center" disabled={list.isPending} onClick={() => list.mutate({ access, cursor: nextCursor })}>
                {p.loadMore}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/** La conversación y su traza, sin acciones: desde soporte no se responde ni se cambia nada. */
function ReadOnlyConversation({ detail, onBack }: { detail: ConversationDetail; onBack: () => void }) {
  const { t, locale } = useI18n();
  const p = t.platform;
  const c = t.inbox;
  const [withTrace, setWithTrace] = useState(true);
  const conv = detail.conversation;
  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={onBack} className="flex items-center gap-1 self-start text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {p.backToList}
      </button>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-2xl font-display font-bold">{conv.customer?.name ?? p.noName}</h2>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{c.channel[conv.channel] ?? conv.channel}</span>
          {conv.handoff ? <Badge tone="warning">{c.needsTeam}</Badge> : null}
        </p>
      </div>
      <p className="rounded-lg bg-info-bg px-4 py-3 text-sm text-info">{p.readOnlyNote}</p>
      <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" aria-pressed={withTrace} onClick={() => setWithTrace((v) => !v)}>
            {withTrace ? p.hideTrace : p.showTrace}
          </Button>
        </div>
        <ol className="flex flex-col gap-3">
          {timeline(detail.trace, withTrace).map((e) => (
            <li key={`${e.kind}-${e.order}`}>
              {e.kind === "message" ? (
                <Bubble
                  author={e.author}
                  label={e.author === "customer" ? c.you : e.author === "staff" ? c.team : c.agent}
                  time={formatMoment(e.at, locale)}
                  text={e.text}
                />
              ) : e.kind === "tool" ? (
                <ToolCard tool={e.tool} />
              ) : e.kind === "context" ? (
                <ContextNote text={e.text} />
              ) : (
                <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                  {c.modelError}: {e.error}
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function AccessLog() {
  const { t, locale } = useI18n();
  const p = t.platform;
  const businesses = useQuery(platformBusinessesQuery);
  const [businessId, setBusinessId] = useState("");
  const log = useQuery(supportLogQuery(businessId || undefined));
  return (
    <div className="flex flex-col gap-4">
      <Field id="log-business" label={p.business} className="max-w-xs">
        <Select id="log-business" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
          <option value="">{p.allBusinesses}</option>
          {(businesses.data ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <Loaded query={log}>
        {(page) =>
          page.items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{p.logEmpty}</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th className="px-4 py-3 font-semibold">{p.logWhen}</th>
                    <th className="px-4 py-3 font-semibold">{p.logWho}</th>
                    <th className="px-4 py-3 font-semibold">{p.logBusiness}</th>
                    <th className="px-4 py-3 font-semibold">{p.logReason}</th>
                    <th className="px-4 py-3 font-semibold">{p.logWhat}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {page.items.map((i) => (
                    <tr key={i.id} className="align-top">
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatMoment(i.at, locale)}</td>
                      <td className="px-4 py-3">
                        <span className="block font-semibold">{i.user?.name ?? "—"}</span>
                        <span className="block text-xs text-muted">{i.user?.email}</span>
                      </td>
                      <td className="px-4 py-3">{i.business.name}</td>
                      <td className="px-4 py-3">{i.reason}</td>
                      <td className="px-4 py-3 text-muted">{i.conversationId ? p.logConversation : p.logList}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
    </div>
  );
}
