import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Service, Staff, StaffPatchResult } from "@hablahora/contracts";
import { Badge, Button, Field, Input, Sheet, SwitchField } from "@hablahora/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "../components/AppShell.js";
import { Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { ScheduleEditor, scheduleHasErrors } from "../components/ScheduleEditor.js";
import { useI18n } from "../i18n.js";
import { hoursQuery, servicesQuery, staffQuery, write } from "../queries.js";
import { fromDays, summarize, toDays, type DayHours } from "../schedule.js";
import { useSave } from "./save.js";

export function StaffPage() {
  const { t } = useI18n();
  const c = t.cfg.staff;
  const canEdit = useCanEdit();
  const staff = useQuery(staffQuery);
  const services = useQuery(servicesQuery);
  const [editing, setEditing] = useState<Staff | "new" | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={t.nav.staff} subtitle={c.subtitle} />
        {canEdit ? (
          <Button variant="brand" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {c.add}
          </Button>
        ) : null}
      </div>
      <ReadOnlyNote />
      <Loaded query={staff}>
        {(list) =>
          list.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{c.empty}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {list.map((m) => {
                const names = (services.data ?? []).filter((s) => m.serviceIds.includes(s.id)).map((s) => s.name);
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-2 font-semibold">
                        {m.name}
                        {!m.active ? <Badge>{t.cfg.common.inactive}</Badge> : null}
                      </p>
                      <p className="text-sm text-muted">{names.length ? names.join(", ") : c.noServices}</p>
                      <p className="text-sm text-muted">{m.schedule ? summarize(m.schedule, t.cfg.daysShort) : c.sameAsBusiness}</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setEditing(m)}>
                      {canEdit ? t.cfg.common.edit : t.cfg.common.open}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} title={editing === "new" ? c.newTitle : c.editTitle}>
        {editing ? (
          <StaffForm
            key={editing === "new" ? "new" : editing.id}
            member={editing === "new" ? null : editing}
            services={services.data ?? []}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function StaffForm({ member, services, onDone }: { member: Staff | null; services: Service[]; onDone: () => void }) {
  const { t } = useI18n();
  const c = t.cfg.staff;
  const canEdit = useCanEdit();
  const queryClient = useQueryClient();
  const businessHours = useQuery(hoursQuery).data?.schedule ?? [];
  const [name, setName] = useState(member?.name ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>(member?.serviceIds ?? []);
  const [active, setActive] = useState(member?.active ?? true);
  const [own, setOwn] = useState(member?.schedule != null);
  // horario propio: el que tenía, o arranca desde el del local
  const [days, setDays] = useState<DayHours[]>(toDays(member?.schedule ?? businessHours));
  const [nameError, setNameError] = useState<string | null>(null);

  const save = useSave({
    mutation: async () => {
      const body = { name: name.trim(), active, serviceIds };
      const saved = member
        ? await write<StaffPatchResult>("PATCH", `/api/merchant/staff/${member.id}`, body)
        : await write<Staff>("POST", "/api/merchant/staff", body);
      const schedule = own ? fromDays(days) : null;
      const changed = JSON.stringify(schedule) !== JSON.stringify(member?.schedule ?? null);
      if (changed || !member) await write<Staff>("PUT", `/api/merchant/staff/${saved.id}/schedule`, { schedule });
      return saved;
    },
    invalidates: [staffQuery.queryKey, servicesQuery.queryKey],
    successText: member ? undefined : c.created,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setNameError(c.nameRequired);
    if (own && scheduleHasErrors(days)) return;
    setNameError(null);
    save.mutate(undefined, {
      onSuccess: (result) => {
        // al desactivar: avisos de lo que quedó (no se cancela nada)
        if ("futureBookings" in result) {
          const r = result as StaffPatchResult;
          if (r.futureBookings > 0) toast.warning(c.futureBookings(r.futureBookings));
          if (r.servicesWithoutStaff.length) toast.warning(c.orphanServices(r.servicesWithoutStaff.join(", ")));
        }
        void queryClient.invalidateQueries({ queryKey: hoursQuery.queryKey });
        onDone();
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <fieldset disabled={!canEdit} className="flex flex-col gap-5">
        <Field id="staff-name" label={c.name} error={nameError ?? undefined}>
          <Input id="staff-name" value={name} aria-invalid={!!nameError} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">{c.services}</legend>
          <div className="flex flex-wrap gap-2">
            {services.map((s) => (
              <label key={s.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--ui-accent)]"
                  checked={serviceIds.includes(s.id)}
                  onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((id) => id !== s.id))}
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
        <SwitchField id="staff-active" label={c.active} checked={active} onCheckedChange={setActive} disabled={!canEdit} />
        <SwitchField id="staff-own" label={c.ownSchedule} hint={c.ownScheduleHint} checked={own} onCheckedChange={setOwn} disabled={!canEdit} />
        {own ? <ScheduleEditor id="staff-schedule" value={days} onChange={setDays} disabled={!canEdit} /> : null}
        {canEdit ? (
          <div className="flex gap-2">
            <Button type="submit" variant="brand" disabled={save.isPending}>
              {t.cfg.common.save}
            </Button>
            <Button variant="outline" onClick={onDone}>
              {t.common.cancel}
            </Button>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}
