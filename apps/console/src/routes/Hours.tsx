import { useQuery } from "@tanstack/react-query";
import type { Closure, Hours } from "@hablahora/contracts";
import { Button, ConfirmDialog, Field, Input, Select } from "@hablahora/ui";
import { useState } from "react";
import { PageHeader } from "../components/AppShell.js";
import { Card, Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { ScheduleEditor, scheduleHasErrors } from "../components/ScheduleEditor.js";
import { formatDate, useI18n } from "../i18n.js";
import { closuresQuery, hoursQuery, staffQuery, write } from "../queries.js";
import { fromDays, toDays, type DayHours } from "../schedule.js";
import { useSave } from "./save.js";

export function HoursPage() {
  const { t } = useI18n();
  const hours = useQuery(hoursQuery);
  return (
    <>
      <PageHeader title={t.nav.hours} subtitle={t.cfg.hours.subtitle} />
      <ReadOnlyNote />
      <div className="flex flex-col gap-10">
        <Loaded query={hours}>{(h) => <WeeklyHours initial={h} />}</Loaded>
        <Closures />
      </div>
    </>
  );
}

function WeeklyHours({ initial }: { initial: Hours }) {
  const { t } = useI18n();
  const canEdit = useCanEdit();
  const [days, setDays] = useState<DayHours[]>(toDays(initial.schedule));
  const save = useSave({ mutation: (h: Hours) => write<Hours>("PUT", "/api/merchant/hours", h), updates: hoursQuery.queryKey });
  const noneOpen = !days.some((d) => d.open);

  return (
    <section aria-labelledby="weekly-title" className="flex flex-col gap-3">
      <h2 id="weekly-title" className="text-lg font-semibold">
        {t.cfg.hours.weekly}
      </h2>
      <ScheduleEditor id="business-hours" value={days} onChange={setDays} disabled={!canEdit} />
      {noneOpen ? <p className="text-sm text-warning">{t.cfg.schedule.empty}</p> : null}
      {canEdit ? (
        <div>
          <Button variant="brand" disabled={save.isPending || scheduleHasErrors(days)} onClick={() => save.mutate({ schedule: fromDays(days) })}>
            {t.cfg.common.save}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Closures() {
  const { t, locale } = useI18n();
  const c = t.cfg.hours;
  const canEdit = useCanEdit();
  const closures = useQuery(closuresQuery);
  const staff = useQuery(staffQuery);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [staffId, setStaffId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Closure | null>(null);

  const add = useSave({
    mutation: () =>
      write<Closure>("POST", "/api/merchant/closures", { from, to: to || from, staffId: staffId || null, reason: reason.trim() || null }),
    invalidates: [closuresQuery.queryKey],
    successText: c.closureAdded,
  });
  const remove = useSave({
    mutation: (id: string) => write<void>("DELETE", `/api/merchant/closures/${id}`),
    invalidates: [closuresQuery.queryKey],
    successText: c.closureDeleted,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!from) return setError(c.dateRequired);
    if (to && to < from) return setError(c.toBeforeFrom);
    setError(null);
    add.mutate(undefined, {
      onSuccess: () => {
        setFrom("");
        setTo("");
        setStaffId("");
        setReason("");
      },
    });
  };

  const who = (id: string | null) => (id ? (staff.data?.find((m) => m.id === id)?.name ?? "—") : c.wholeBusiness);
  const range = (cl: Closure) =>
    cl.from === cl.to ? formatDate(`${cl.from}T12:00:00`, locale) : `${formatDate(`${cl.from}T12:00:00`, locale)} – ${formatDate(`${cl.to}T12:00:00`, locale)}`;

  return (
    <section aria-labelledby="closures-title" className="flex flex-col gap-3">
      <div>
        <h2 id="closures-title" className="text-lg font-semibold">
          {c.closures}
        </h2>
        <p className="text-sm text-muted">{c.closuresHint}</p>
      </div>
      <Loaded query={closures}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted">{c.noClosures}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {list.map((cl) => (
                <li key={cl.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-semibold">{range(cl)}</p>
                    <p className="text-sm text-muted">
                      {who(cl.staffId)}
                      {cl.reason ? ` · ${cl.reason}` : ""}
                    </p>
                  </div>
                  {canEdit ? (
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(cl)}>
                      {t.cfg.common.delete}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      {canEdit ? (
        <Card>
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="closure-from" label={c.from} error={error ?? undefined}>
                <Input id="closure-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={!!error} />
              </Field>
              <Field id="closure-to" label={`${c.to} (${t.cfg.common.optional.toLowerCase()})`}>
                <Input id="closure-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field id="closure-who" label={c.who}>
                <Select id="closure-who" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                  <option value="">{c.wholeBusiness}</option>
                  {(staff.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="closure-reason" label={`${c.reason} (${t.cfg.common.optional.toLowerCase()})`}>
                <Input id="closure-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="outline" disabled={add.isPending}>
                {c.addClosure}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deleting ? `${t.cfg.common.delete}: ${range(deleting)}` : ""}
        description={deleting ? who(deleting.staffId) : ""}
        confirmLabel={t.cfg.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </section>
  );
}
