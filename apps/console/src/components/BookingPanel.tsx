import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomerSearchResult, MerchantBooking, Service } from "@hablahora/contracts";
import { Badge, Button, cn, Field, Input, Select, Textarea } from "@hablahora/ui";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { hasStarted } from "../agenda.js";
import { ApiError, errorText } from "../api.js";
import { useI18n, type Locale } from "../i18n.js";
import { availabilityQuery, customersQuery, servicesQuery, staffQuery, write } from "../queries.js";

// ---------------------------------------------------------------------
// Apoyo
// ---------------------------------------------------------------------

type Tone = "neutral" | "success" | "warning" | "info" | "danger";

export const STATUS_TONE: Record<string, Tone> = {
  hold: "warning",
  pending: "warning",
  confirmed: "success",
  seated: "info",
  completed: "info",
  no_show: "danger",
  cancelled: "neutral",
  expired: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{t.agenda.status[status] ?? status}</Badge>;
}

/** "miércoles, 14 de octubre" en el idioma de la consola (la fecha ya es la local del negocio). */
export function formatDay(date: string, locale: Locale, opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es", { ...opts, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

/** Acción sobre una reserva: aviso, errores en el idioma de la consola y la agenda y el listado al día. */
export function useBookingAction<TInput>(fn: (input: TInput) => Promise<MerchantBooking>, successText: string, onDone?: (b: MerchantBooking) => void) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (booking) => {
      await Promise.all(
        [["agenda"], ["bookings"], ["availability"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      toast.success(successText);
      onDone?.(booking);
    },
    onError: (err) => toast.error(errorText(err, t.agenda.errors, t.common.genericError)),
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------
// Detalle de una reserva
// ---------------------------------------------------------------------

/** Detalle y acciones de una reserva: confirmar, atendida / no vino, mover, cancelar. */
export function BookingDetails({
  booking,
  timezone,
  onChange,
  onClose,
}: {
  booking: MerchantBooking;
  timezone: string;
  /** la reserva tal como quedó después de confirmar o marcar su estado */
  onChange: (b: MerchantBooking) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const a = t.agenda;
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [reason, setReason] = useState("");
  const id = booking.id;

  const confirm = useBookingAction(() => write<MerchantBooking>("POST", `/api/merchant/bookings/${id}/confirm`), a.confirmed, onChange);
  const status = useBookingAction(
    (s: "completed" | "no_show") => write<MerchantBooking>("POST", `/api/merchant/bookings/${id}/status`, { status: s }),
    a.statusSaved,
    onChange,
  );
  const cancel = useBookingAction(
    () => write<MerchantBooking>("POST", `/api/merchant/bookings/${id}/cancel`, { reason: reason.trim() || null }),
    a.cancelled,
    onClose,
  );

  if (mode === "move") return <MoveForm booking={booking} onDone={onClose} onBack={() => setMode("view")} />;

  const active = ["hold", "pending", "confirmed"].includes(booking.status);
  const started = hasStarted(booking, timezone);
  const busy = confirm.isPending || status.isPending || cancel.isPending;
  const c = booking.customer;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={booking.status} />
          <span className="text-sm text-muted">{a.source[booking.source] ?? booking.source}</span>
        </div>
        <p className="text-2xl font-display font-bold">{c?.name ?? a.noContact}</p>
      </div>
      <dl className="flex flex-col divide-y divide-line">
        <Row label={a.when}>
          <span className="block first-letter:uppercase">{formatDay(booking.date, locale)}</span>
          <span className="block tabular-nums">
            {booking.time}–{booking.endTime}
          </span>
        </Row>
        <Row label={a.service}>{booking.service.name}</Row>
        <Row label={a.staff}>{booking.staff?.name ?? "—"}</Row>
        <Row label={a.contact}>
          {c?.phone || c?.email ? (
            <span className="flex flex-col">
              {c.phone ? <a href={`tel:${c.phone}`} className="tabular-nums underline-offset-4 hover:underline">{c.phone}</a> : null}
              {c.email ? <a href={`mailto:${c.email}`} className="underline-offset-4 hover:underline">{c.email}</a> : null}
            </span>
          ) : (
            <span className="text-muted">{a.noContact}</span>
          )}
        </Row>
        {booking.notes ? <Row label={a.notes}>{booking.notes}</Row> : null}
      </dl>
      {booking.conversationId ? (
        <Link
          to="/conversaciones/$id"
          params={{ id: booking.conversationId }}
          className="self-start text-sm font-semibold text-brand-text underline-offset-4 hover:underline"
        >
          {t.inbox.openConversation}
        </Link>
      ) : null}

      {mode === "cancel" ? (
        <form
          className="flex flex-col gap-4 rounded-2xl border border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            cancel.mutate(undefined);
          }}
        >
          <h3 className="font-semibold">{a.cancelTitle}</h3>
          <Field id="cancel-reason" label={a.cancelReason} hint={a.cancelReasonHint}>
            <Textarea id="cancel-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="text-sm text-muted">{a.notifies}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="brand" disabled={busy}>
              {a.cancelSubmit}
            </Button>
            <Button variant="outline" onClick={() => setMode("view")}>
              {a.keep}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {booking.status === "pending" || booking.status === "hold" ? (
            <Button variant="brand" disabled={busy} onClick={() => confirm.mutate(undefined)}>
              {a.confirm}
            </Button>
          ) : null}
          {started && ["pending", "confirmed", "completed", "no_show"].includes(booking.status) ? (
            <>
              <Button variant="outline" disabled={busy || booking.status === "completed"} onClick={() => status.mutate("completed")}>
                {a.markCompleted}
              </Button>
              <Button variant="outline" disabled={busy || booking.status === "no_show"} onClick={() => status.mutate("no_show")}>
                {a.markNoShow}
              </Button>
            </>
          ) : null}
          {booking.status === "pending" || booking.status === "confirmed" ? (
            <Button variant="outline" disabled={busy} onClick={() => setMode("move")}>
              {a.move}
            </Button>
          ) : null}
          {active ? (
            <Button variant="ghost" className="text-danger" disabled={busy} onClick={() => setMode("cancel")}>
              {a.cancel}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Elegir día, profesional y hora (mover y nueva reserva)
// ---------------------------------------------------------------------

interface Slot {
  date: string;
  staffId: string;
  time: string;
  outsideHours: boolean;
}

function SlotPicker({
  idPrefix,
  service,
  value,
  onChange,
  bookingId,
  allowAnyStaff,
  error,
}: {
  idPrefix: string;
  service: Service | undefined;
  value: Slot;
  onChange: (v: Slot) => void;
  bookingId?: string;
  allowAnyStaff: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const a = t.agenda;
  const staff = useQuery(staffQuery).data ?? [];
  const doers = staff.filter((s) => s.active && service?.staffIds.includes(s.id));
  const free = useQuery({
    ...availabilityQuery({ serviceId: service?.id ?? "", date: value.date, staffId: value.staffId || undefined, bookingId }),
    enabled: !!service && !!value.date && !value.outsideHours,
  });
  const set = (patch: Partial<Slot>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-date`} label={a.date}>
          <Input id={`${idPrefix}-date`} type="date" value={value.date} onChange={(e) => set({ date: e.target.value, time: "" })} />
        </Field>
        <Field id={`${idPrefix}-staff`} label={a.staff}>
          <Select id={`${idPrefix}-staff`} value={value.staffId} onChange={(e) => set({ staffId: e.target.value, time: "" })}>
            {allowAnyStaff ? <option value="">{a.anyStaff}</option> : null}
            {doers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 accent-[var(--ui-accent)]"
          checked={value.outsideHours}
          onChange={(e) => set({ outsideHours: e.target.checked, time: "" })}
        />
        <span>
          <span className="font-semibold">{a.outsideHours}</span>
          <span className="block text-muted">{a.outsideHoursHint}</span>
        </span>
      </label>
      {value.outsideHours ? (
        <Field id={`${idPrefix}-time`} label={a.time} error={error}>
          <Input id={`${idPrefix}-time`} type="time" step={300} value={value.time} onChange={(e) => set({ time: e.target.value })} />
        </Field>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">{a.freeTimes}</legend>
          {!service || free.isPending ? (
            <p className="text-sm text-muted">{t.common.loading}</p>
          ) : free.isError ? (
            <p className="text-sm text-danger">{t.common.loadError}</p>
          ) : free.data.times.length === 0 ? (
            <p className="text-sm text-muted">{a.noFreeTimes}</p>
          ) : (
            <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
              {free.data.times.map((x) => (
                <button
                  key={x.time}
                  type="button"
                  aria-pressed={value.time === x.time}
                  onClick={() => set({ time: x.time })}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-accent",
                    value.time === x.time ? "border-ink bg-ink font-semibold text-bg" : "border-line hover:border-ink",
                  )}
                >
                  {x.time}
                </button>
              ))}
            </div>
          )}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Mover
// ---------------------------------------------------------------------

function MoveForm({ booking, onDone, onBack }: { booking: MerchantBooking; onDone: () => void; onBack: () => void }) {
  const { t, locale } = useI18n();
  const a = t.agenda;
  const service = useQuery(servicesQuery).data?.find((s) => s.id === booking.service.id);
  const [slot, setSlot] = useState<Slot>({ date: booking.date, staffId: booking.staff?.id ?? "", time: "", outsideHours: false });
  const [error, setError] = useState<string>();
  const move = useBookingAction(
    () =>
      write<MerchantBooking>("POST", `/api/merchant/bookings/${booking.id}/reschedule`, {
        date: slot.date,
        time: slot.time,
        staffId: slot.staffId || null,
        outsideHours: slot.outsideHours,
      }),
    a.moved,
    onDone,
  );

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!slot.time) return setError(a.pickTime);
        setError(undefined);
        move.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{a.moveTitle}</h3>
        <p className="text-sm text-muted">
          {booking.customer?.name} · {booking.service.name} ·{" "}
          {formatDay(booking.date, locale, { weekday: "short", day: "numeric", month: "short" })} {booking.time}
        </p>
      </div>
      <SlotPicker idPrefix="move" service={service} value={slot} onChange={setSlot} bookingId={booking.id} allowAnyStaff={false} error={error} />
      <p className="text-sm text-muted">{a.notifies}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="brand" disabled={move.isPending}>
          {a.move}
        </Button>
        <Button variant="outline" onClick={onBack}>
          {a.keep}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
// Nueva reserva
// ---------------------------------------------------------------------

type CustomerChoice = CustomerSearchResult["items"][number];

/** Reserva hecha por el equipo: servicio, profesional, hora y cliente (existente o nuevo). */
export function NewBookingForm({
  initial,
  onDone,
}: {
  initial: { date: string; staffId?: string; time?: string };
  onDone: (b: MerchantBooking) => void;
}) {
  const { t } = useI18n();
  const a = t.agenda;
  const services = (useQuery(servicesQuery).data ?? []).filter((s) => s.active && s.staffIds.length > 0);
  const [serviceId, setServiceId] = useState("");
  const service = services.find((s) => s.id === (serviceId || pickService(services, initial.staffId)));
  const [slot, setSlot] = useState<Slot>({ date: initial.date, staffId: initial.staffId ?? "", time: initial.time ?? "", outsideHours: false });
  const [customerMode, setCustomerMode] = useState<"search" | "new">("search");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<CustomerChoice | null>(null);
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const found = useQuery(customersQuery(query.trim()));

  const create = useBookingAction(
    () =>
      write<MerchantBooking>("POST", "/api/merchant/bookings", {
        serviceId: service!.id,
        date: slot.date,
        time: slot.time,
        staffId: slot.staffId || null,
        outsideHours: slot.outsideHours,
        notes: notes.trim() || null,
        customer:
          customerMode === "search" && picked
            ? { id: picked.id }
            : { name: contact.name.trim(), phone: contact.phone.trim() || null, email: contact.email.trim() || null },
      }),
    a.created,
    onDone,
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!slot.time) next.time = a.pickTime;
    if (customerMode === "search" && !picked) next.customer = a.pickCustomer;
    if (customerMode === "new") {
      if (!contact.name.trim()) next.name = a.nameRequired;
      if (!contact.phone.trim() && !contact.email.trim()) next.phone = a.contactRequired;
    }
    setErrors(next);
    if (Object.keys(next).length === 0 && service) {
      create.mutate(undefined, {
        onError: (err) => {
          if (err instanceof ApiError && err.reason === "invalid_customer") setErrors({ phone: a.errors.invalid_customer });
        },
      });
    }
  };

  // si el profesional elegido no hace el servicio, se vuelve a "el primero libre"
  const changeService = (id: string) => {
    setServiceId(id);
    const s = services.find((x) => x.id === id);
    setSlot((v) => ({ ...v, time: "", staffId: s && v.staffId && !s.staffIds.includes(v.staffId) ? "" : v.staffId }));
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <Field id="new-service" label={a.service}>
        <Select id="new-service" value={service?.id ?? ""} onChange={(e) => changeService(e.target.value)}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.durationMin} {t.cfg.common.minutes}
            </option>
          ))}
        </Select>
      </Field>
      <SlotPicker idPrefix="new" service={service} value={slot} onChange={setSlot} allowAnyStaff error={errors.time} />

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">{a.customer}</legend>
        {customerMode === "search" ? (
          picked ? (
            <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{picked.name ?? "—"}</span>
                <span className="block truncate text-sm text-muted">{[picked.phone, picked.email].filter(Boolean).join(" · ")}</span>
              </span>
              <Button variant="outline" size="sm" onClick={() => setPicked(null)}>
                {a.change}
              </Button>
            </div>
          ) : (
            <>
              <Field id="new-customer-search" label={a.searchCustomer} hint={a.searchHint} error={errors.customer}>
                <Input id="new-customer-search" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
              </Field>
              {query.trim().length >= 2 && found.data ? (
                found.data.items.length ? (
                  <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                    {found.data.items.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent"
                          onClick={() => setPicked(c)}
                        >
                          <span className="block font-semibold">{c.name ?? "—"}</span>
                          <span className="block truncate text-sm text-muted">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">{a.noMatches}</p>
                )
              ) : null}
              <Button variant="outline" size="sm" className="self-start" onClick={() => setCustomerMode("new")}>
                {a.newCustomer}
              </Button>
            </>
          )
        ) : (
          <>
            <Field id="new-name" label={a.name} error={errors.name}>
              <Input id="new-name" autoComplete="off" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="new-phone" label={a.phone} error={errors.phone}>
                <Input id="new-phone" type="tel" autoComplete="off" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
              </Field>
              <Field id="new-email" label={a.email}>
                <Input id="new-email" type="email" autoComplete="off" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
              </Field>
            </div>
            <Button variant="outline" size="sm" className="self-start" onClick={() => setCustomerMode("search")}>
              {a.existingCustomer}
            </Button>
          </>
        )}
      </fieldset>

      <Field id="new-notes" label={a.notes} hint={t.cfg.common.optional}>
        <Textarea id="new-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <p className="text-sm text-muted">{a.notifies}</p>
      <Button type="submit" variant="brand" className="self-start" disabled={create.isPending || !service}>
        {a.save}
      </Button>
    </form>
  );
}

/** Servicio inicial: el primero que haga el profesional de la columna donde se hizo clic. */
function pickService(services: Service[], staffId?: string): string | undefined {
  return (staffId ? services.find((s) => s.staffIds.includes(staffId)) : undefined)?.id ?? services[0]?.id;
}
