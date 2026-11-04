import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { MerchantBooking } from "@hablahora/contracts";
import { Field, Input, Select, Sheet } from "@hablahora/ui";
import { useEffect, useState } from "react";
import { addDays, todayIn } from "../agenda.js";
import { PageHeader } from "../components/AppShell.js";
import { BookingDetails, formatDay, StatusBadge } from "../components/BookingPanel.js";
import { Loaded } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { bookingsQuery, businessQuery, staffQuery, type BookingFilters } from "../queries.js";

const STATUSES = ["pending", "confirmed", "completed", "no_show", "cancelled", "hold", "expired"];
const MAX_DAYS = 62;

export interface BookingsSearch {
  from?: string;
  to?: string;
  status?: string;
  staffId?: string;
  q?: string;
}

/** Listado de reservas: rango de fechas, estado, profesional y búsqueda por cliente. */
export function BookingsPage({ search }: { search: BookingsSearch }) {
  const { t, locale } = useI18n();
  const a = t.agenda;
  const navigate = useNavigate();
  const timezone = useQuery(businessQuery).data?.timezone;
  const staff = useQuery(staffQuery).data ?? [];
  const today = timezone ? todayIn(timezone) : undefined;
  const from = search.from ?? today ?? "";
  const to = search.to ?? (from ? addDays(from, 30) : "");
  const tooLong = !!from && !!to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS;
  const invalid = !from || !to || to < from || tooLong;
  const filters: BookingFilters = { from, to, status: search.status, staffId: search.staffId, q: search.q };
  const list = useQuery({ ...bookingsQuery(filters), enabled: !invalid });
  const [open, setOpen] = useState<MerchantBooking | null>(null);

  // la búsqueda se aplica al dejar de escribir
  const [text, setText] = useState(search.q ?? "");
  useEffect(() => {
    const id = setTimeout(() => {
      if ((search.q ?? "") !== text.trim()) set({ q: text.trim() || undefined });
    }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // sobre los filtros vigentes (la búsqueda con retardo no debe pisar un filtro elegido mientras tanto)
  function set(patch: Partial<BookingsSearch>) {
    void navigate({ to: "/reservas", search: (prev: BookingsSearch) => ({ ...prev, from, to, ...patch }), replace: true });
  }

  return (
    <>
      <PageHeader title={a.listTitle} subtitle={a.listSubtitle} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field id="list-from" label={a.from}>
          <Input id="list-from" type="date" value={from} onChange={(e) => e.target.value && set({ from: e.target.value })} />
        </Field>
        <Field id="list-to" label={a.to} error={tooLong ? a.rangeTooLong : undefined}>
          <Input id="list-to" type="date" value={to} aria-invalid={tooLong} onChange={(e) => e.target.value && set({ to: e.target.value })} />
        </Field>
        <Field id="list-status" label={a.statusFilter}>
          <Select id="list-status" value={search.status ?? ""} onChange={(e) => set({ status: e.target.value || undefined })}>
            <option value="">{a.allStatuses}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {a.status[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="list-staff" label={a.staff}>
          <Select id="list-staff" value={search.staffId ?? ""} onChange={(e) => set({ staffId: e.target.value || undefined })}>
            <option value="">{a.allStaff}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="list-q" label={a.search}>
          <Input id="list-q" type="search" placeholder={a.searchPlaceholder} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>

      {invalid ? null : (
        <Loaded query={list}>
          {({ items }) =>
            items.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{a.empty}</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-muted">{a.count(items.length)}</p>
                <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
                  {items.map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => setOpen(b)}
                        className="grid w-full grid-cols-[5.5rem_1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent sm:grid-cols-[8rem_1fr_10rem_auto]"
                      >
                        <span className="tabular-nums">
                          <span className="block text-sm text-muted first-letter:uppercase">
                            {formatDay(b.date, locale, { weekday: "short", day: "numeric", month: "short" })}
                          </span>
                          <span className="block font-semibold">{b.time}</span>
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{b.customer?.name ?? "—"}</span>
                          <span className="block truncate text-sm text-muted">
                            {b.service.name}
                            <span className="sm:hidden"> · {b.staff?.name}</span>
                          </span>
                        </span>
                        <span className="hidden truncate text-sm text-muted sm:block">{b.staff?.name ?? "—"}</span>
                        <StatusBadge status={b.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )
          }
        </Loaded>
      )}

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={a.details}>
        {open && timezone ? <BookingDetails key={open.id} booking={open} timezone={timezone} onChange={setOpen} onClose={() => setOpen(null)} /> : null}
      </Sheet>
    </>
  );
}
