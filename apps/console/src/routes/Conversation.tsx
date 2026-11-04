import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ConversationDetail, MerchantBooking } from "@hablahora/contracts";
import { Badge, Button, cn, Field, Sheet, Textarea } from "@hablahora/ui";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorText } from "../api.js";
import { BookingDetails, formatDay, StatusBadge } from "../components/BookingPanel.js";
import { Loaded } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { businessQuery, conversationQuery, handoffCountQuery, meQuery, organizationQuery, write } from "../queries.js";
import { formatMoment } from "./Conversations.js";

type Trace = ConversationDetail["trace"];
type Entry =
  | { kind: "message"; at: string; order: number; author: string; authorUserId: string | null; text: string }
  | { kind: "tool"; at: string; order: number; tool: Trace["llmCalls"][number]["toolCalls"][number] }
  | { kind: "model_error"; at: string; order: number; error: string }
  /** contexto para el agente (fecha, idioma, datos del cliente): solo con la traza abierta */
  | { kind: "context"; at: string; order: number; text: string };

/**
 * La conversación en orden: los textos que vio el cliente y, con la traza
 * abierta, las herramientas que usó el agente y las llamadas que fallaron.
 */
export function timeline(trace: Trace, withTrace: boolean): Entry[] {
  const entries: Entry[] = [];
  for (const m of trace.messages) {
    const text = (m.content as { type?: string; text?: string }[])
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text || m.author === "tool") continue;
    if (m.author === "system") {
      if (withTrace) entries.push({ kind: "context", at: m.createdAt, order: m.id, text });
      continue;
    }
    entries.push({ kind: "message", at: m.createdAt, order: m.id, author: m.author, authorUserId: m.authorUserId, text });
  }
  if (withTrace) {
    for (const call of trace.llmCalls) {
      if (call.error) entries.push({ kind: "model_error", at: call.createdAt, order: call.id, error: call.error });
      for (const tool of call.toolCalls) entries.push({ kind: "tool", at: tool.createdAt, order: tool.id, tool });
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
}

export function ConversationPage({ id }: { id: string }) {
  const query = useQuery(conversationQuery(id));
  return <Loaded query={query}>{(detail) => <ConversationView detail={detail} />}</Loaded>;
}

function ConversationView({ detail }: { detail: ConversationDetail }) {
  const { t, locale } = useI18n();
  const c = t.inbox;
  const queryClient = useQueryClient();
  const me = useQuery(meQuery).data!;
  const timezone = useQuery(businessQuery).data?.timezone;
  const org = useQuery(organizationQuery(me.business!.organizationId));
  const [withTrace, setWithTrace] = useState(false);
  const [text, setText] = useState("");
  const [open, setOpen] = useState<MerchantBooking | null>(null);
  const conv = detail.conversation;
  const names = new Map((org.data?.members ?? []).map((m) => [m.userId, m.user.name]));

  const action = useMutation({
    mutationFn: (a: { path: "reply" | "take" | "release"; body?: unknown; done: string }) =>
      write<ConversationDetail>("POST", `/api/merchant/conversations/${conv.id}/${a.path}`, a.body ?? {}),
    onSuccess: async (updated, a) => {
      queryClient.setQueryData(conversationQuery(conv.id).queryKey, updated);
      await Promise.all([handoffCountQuery.queryKey, ["conversations"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (a.path === "reply") setText("");
      toast.success(a.done);
    },
    onError: (err) => toast.error(errorText(err, c.errors, t.common.genericError)),
  });

  const takenByTeam = conv.handoffReason?.startsWith("staff:");
  const web = conv.channel === "web";

  return (
    <div className="flex flex-col gap-6">
      <Link to="/conversaciones" className="flex items-center gap-1 self-start text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {c.back}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-display font-bold">{conv.customer?.name ?? c.anonymous}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{c.channel[conv.channel] ?? conv.channel}</span>
            {[conv.customer?.phone, conv.customer?.email ?? conv.verifiedEmail].filter(Boolean).map((v) => (
              <span key={v}>· {v}</span>
            ))}
            {conv.handoff ? <Badge tone="warning">{c.needsTeam}</Badge> : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {conv.handoff ? (
            <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate({ path: "release", done: c.released })}>
              {c.release}
            </Button>
          ) : (
            <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate({ path: "take", done: c.taken })}>
              {c.take}
            </Button>
          )}
        </div>
      </div>

      {conv.handoff ? (
        <div className="flex flex-col gap-1 rounded-2xl bg-warning-bg px-5 py-4 text-warning">
          <p className="font-semibold">{c.waitingBanner}</p>
          {conv.handoffReason ? <p className="text-sm">{takenByTeam ? c.takenBy : c.reason(conv.handoffReason)}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <section aria-labelledby="conv-title" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="conv-title" className="text-lg font-semibold">
              {c.conversation}
            </h2>
            <Button variant="ghost" size="sm" aria-pressed={withTrace} onClick={() => setWithTrace((v) => !v)}>
              {withTrace ? c.hideTrace : c.showTrace}
            </Button>
          </div>
          {withTrace ? <p className="-mt-2 text-sm text-muted">{c.traceHint}</p> : null}
          <ol className="flex flex-col gap-3">
            {timeline(detail.trace, withTrace).map((e) => (
              <li key={`${e.kind}-${e.order}`}>
                {e.kind === "message" ? (
                  <Bubble
                    author={e.author}
                    label={
                      e.author === "customer"
                        ? c.you
                        : e.author === "staff"
                          ? names.get(e.authorUserId ?? "")
                            ? c.teamMember(names.get(e.authorUserId ?? "")!)
                            : c.team
                          : c.agent
                    }
                    time={formatMoment(e.at, locale, timezone)}
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

          {conv.handoff && web ? (
            <form
              className="flex flex-col gap-3 border-t border-line pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) action.mutate({ path: "reply", body: { text: text.trim() }, done: c.sent });
              }}
            >
              <Field id="reply-text" label={c.replyLabel} hint={c.replyHint}>
                <Textarea id="reply-text" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <Button type="submit" variant="brand" className="self-start" disabled={action.isPending || !text.trim()}>
                {c.send}
              </Button>
            </form>
          ) : conv.handoff ? (
            <p className="text-sm text-muted">{c.whatsappNote}</p>
          ) : null}
        </section>

        <aside aria-labelledby="related-title" className="flex flex-col gap-3">
          <h2 id="related-title" className="font-semibold">
            {c.related}
          </h2>
          {detail.bookings.length === 0 ? (
            <p className="text-sm text-muted">{c.noBookings}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {detail.bookings.map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => setOpen(b)} className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-bg">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{b.service.name}</span>
                      <StatusBadge status={b.status} />
                    </span>
                    <span className="text-sm text-muted first-letter:uppercase">
                      {formatDay(b.date, locale, { weekday: "short", day: "numeric", month: "short" })} · {b.time} · {b.staff?.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={t.agenda.details}>
        {open && timezone ? (
          <BookingDetails key={open.id} booking={open} timezone={timezone} onChange={setOpen} onClose={() => setOpen(null)} />
        ) : null}
      </Sheet>
    </div>
  );
}

export function Bubble({ author, label, time, text }: { author: string; label: string; time: string; text: string }) {
  const customer = author === "customer";
  return (
    <div className={cn("flex max-w-[85%] flex-col gap-1", customer ? "items-start" : "ml-auto items-end")}>
      <span className="px-1 text-xs text-muted">
        <span className={cn("font-semibold", author === "staff" && "text-info")}>{label}</span> · {time}
      </span>
      <p
        className={cn(
          "rounded-2xl px-3.5 py-2 whitespace-pre-wrap break-words",
          customer && "bg-raised ring-1 ring-line",
          author === "agent" && "bg-ink text-bg",
          author === "staff" && "bg-info-bg text-ink ring-1 ring-info/30",
        )}
      >
        {text}
      </p>
    </div>
  );
}

/** Contexto que recibió el agente en ese turno (no lo ve el cliente). */
export function ContextNote({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-[85%] rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">
      <span className="font-semibold">{t.inbox.context}</span>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
    </div>
  );
}

export function ToolCard({ tool }: { tool: Trace["llmCalls"][number]["toolCalls"][number] }) {
  const { t } = useI18n();
  const c = t.inbox;
  return (
    <details className="ml-auto max-w-[85%] rounded-lg border border-dashed border-line bg-bg px-3 py-2 text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{c.tool}</span>
        <code className="font-semibold">{tool.name}</code>
        {tool.isError ? <Badge tone="danger">{c.toolError}</Badge> : null}
        <span className="text-xs text-muted tabular-nums">{c.ms(tool.durationMs)}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <Json label={c.input} value={tool.input} />
        <Json label={c.result} value={tool.result} />
      </div>
    </details>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <pre className="max-h-64 overflow-auto rounded bg-surface p-2 text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
