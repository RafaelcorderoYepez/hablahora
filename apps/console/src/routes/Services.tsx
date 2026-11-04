import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import type { Service, Staff } from "@hablahora/contracts";
import { formatMoney, formatMoneyInput, parseMoney, type CurrencyCode } from "@hablahora/contracts/browser";
import { Badge, Button, Field, Input, Sheet, SwitchField, Textarea } from "@hablahora/ui";
import { AlertTriangle, Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { PageHeader } from "../components/AppShell.js";
import { LangTabs, Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { businessQuery, servicesQuery, staffQuery, write } from "../queries.js";
import { useSave } from "./save.js";

export function ServicesPage() {
  const { t } = useI18n();
  const s = t.cfg.services;
  const canEdit = useCanEdit();
  const services = useQuery(servicesQuery);
  const staff = useQuery(staffQuery);
  // los precios van en la moneda del negocio (se fija en el alta)
  const currency = useQuery(businessQuery).data?.currency;
  // null: cerrado; "new": crear; un servicio: editarlo
  const [editing, setEditing] = useState<Service | "new" | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={t.nav.services} subtitle={s.subtitle} />
        {canEdit ? (
          <Button variant="brand" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {s.add}
          </Button>
        ) : null}
      </div>
      <ReadOnlyNote />
      <Loaded query={services}>
        {(list) =>
          list.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{s.empty}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {list.map((svc) => {
                const who = (staff.data ?? []).filter((m) => svc.staffIds.includes(m.id));
                const bookable = who.some((m) => m.active);
                return (
                  <li key={svc.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-2 font-semibold">
                        {svc.name}
                        {!svc.active ? <Badge>{t.cfg.common.inactive}</Badge> : null}
                      </p>
                      <p className="text-sm text-muted">
                        {svc.durationMin} {t.cfg.common.minutes}
                        {svc.bufferAfterMin ? ` + ${svc.bufferAfterMin}` : ""} · {svc.price == null ? s.free : currency ? formatMoney(svc.price, currency) : ""} ·{" "}
                        {who.length ? who.map((m) => m.name).join(", ") : s.noStaff}
                      </p>
                    </div>
                    {svc.active && !bookable ? (
                      <span className="inline-flex items-center gap-1 text-sm text-warning">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        {s.noStaff}
                      </span>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => setEditing(svc)}>
                      {canEdit ? t.cfg.common.edit : t.cfg.common.open}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} title={editing === "new" ? s.newTitle : s.editTitle}>
        {editing && currency ? (
          <ServiceForm
            key={editing === "new" ? "new" : editing.id}
            service={editing === "new" ? null : editing}
            staff={staff.data ?? []}
            currency={currency}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

/** Ejemplo de precio en el formato de cada moneda (para el mensaje de error). */
const PRICE_EXAMPLE: Record<CurrencyCode, string> = { CLP: "18.000", USD: "25.50" };

function ServiceForm({
  service,
  staff,
  currency,
  onDone,
}: {
  service: Service | null;
  staff: Staff[];
  currency: CurrencyCode;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const s = t.cfg.services;
  const canEdit = useCanEdit();
  const int = (min: number, max: number, msg: string) =>
    z.string().refine((v) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max, msg);
  const schema = z.object({
    name: z.string().trim().min(1, s.nameRequired).max(120),
    description: z.string().max(1000),
    nameEn: z.string().max(120),
    descriptionEn: z.string().max(1000),
    durationMin: int(5, 720, s.durationRange),
    bufferAfterMin: int(0, 240, s.bufferRange),
    price: z.string().refine((v) => parseMoney(v, currency) !== undefined, s.priceInvalid(PRICE_EXAMPLE[currency])),
    staffIds: z.array(z.string()),
    active: z.boolean(),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: service?.name ?? "",
      description: service?.description ?? "",
      nameEn: service?.nameEn ?? "",
      descriptionEn: service?.descriptionEn ?? "",
      durationMin: String(service?.durationMin ?? 60),
      bufferAfterMin: String(service?.bufferAfterMin ?? 0),
      price: formatMoneyInput(service?.price ?? null, currency),
      staffIds: service?.staffIds ?? [],
      active: service?.active ?? true,
    },
  });
  const save = useSave({
    mutation: (v: Values) => {
      const body = {
        name: v.name,
        description: v.description.trim() || null,
        nameEn: v.nameEn.trim() || null,
        descriptionEn: v.descriptionEn.trim() || null,
        durationMin: Number(v.durationMin),
        bufferAfterMin: Number(v.bufferAfterMin),
        price: parseMoney(v.price, currency) ?? null,
        staffIds: v.staffIds,
        active: v.active,
      };
      return service ? write<Service>("PATCH", `/api/merchant/services/${service.id}`, body) : write<Service>("POST", "/api/merchant/services", body);
    },
    invalidates: [servicesQuery.queryKey, staffQuery.queryKey],
    successText: service ? undefined : s.created,
  });
  const err = form.formState.errors;
  const active = form.watch("active");
  const chosen = form.watch("staffIds");
  const noActiveStaff = active && !staff.some((m) => m.active && chosen.includes(m.id));

  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v, { onSuccess: onDone }))} noValidate>
      <fieldset disabled={!canEdit} className="flex flex-col gap-5">
        <LangTabs
          id="service-text"
          es={
            <div className="flex flex-col gap-4">
              <Field id="svc-name" label={s.name} error={err.name?.message}>
                <Input id="svc-name" aria-invalid={!!err.name} {...form.register("name")} />
              </Field>
              <Field id="svc-description" label={`${s.description} (${t.cfg.common.optional.toLowerCase()})`} hint={s.descriptionHint}>
                <Textarea id="svc-description" rows={3} {...form.register("description")} />
              </Field>
            </div>
          }
          en={
            <div className="flex flex-col gap-4">
              <Field id="svc-nameEn" label={s.nameEn} hint={s.enHint}>
                <Input id="svc-nameEn" {...form.register("nameEn")} />
              </Field>
              <Field id="svc-descriptionEn" label={s.descriptionEn}>
                <Textarea id="svc-descriptionEn" rows={3} {...form.register("descriptionEn")} />
              </Field>
            </div>
          }
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="svc-duration" label={s.duration} error={err.durationMin?.message}>
            <Input id="svc-duration" inputMode="numeric" aria-invalid={!!err.durationMin} {...form.register("durationMin")} />
          </Field>
          <Field id="svc-price" label={s.price(currency)} hint={s.priceHint} error={err.price?.message}>
            <Input id="svc-price" inputMode="decimal" aria-invalid={!!err.price} {...form.register("price")} />
          </Field>
        </div>
        <Field id="svc-buffer" label={s.buffer} hint={s.bufferHint} error={err.bufferAfterMin?.message}>
          <Input id="svc-buffer" inputMode="numeric" className="sm:w-40" aria-invalid={!!err.bufferAfterMin} {...form.register("bufferAfterMin")} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">{s.staff}</legend>
          <p className="text-sm text-muted">{s.staffHint}</p>
          <Controller
            control={form.control}
            name="staffIds"
            render={({ field }) => (
              <div className="flex flex-wrap gap-2">
                {staff.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-[var(--ui-accent)]"
                      checked={field.value.includes(m.id)}
                      onChange={(e) => field.onChange(e.target.checked ? [...field.value, m.id] : field.value.filter((id) => id !== m.id))}
                    />
                    {m.name}
                    {!m.active ? <Badge>{t.cfg.common.inactive}</Badge> : null}
                  </label>
                ))}
              </div>
            )}
          />
        </fieldset>
        <Controller
          control={form.control}
          name="active"
          render={({ field }) => (
            <SwitchField id="svc-active" label={s.active} checked={field.value} onCheckedChange={field.onChange} disabled={!canEdit} />
          )}
        />
        {noActiveStaff ? <p className="rounded-lg bg-warning-bg px-4 py-3 text-sm text-warning">{s.noStaffWarning}</p> : null}
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
