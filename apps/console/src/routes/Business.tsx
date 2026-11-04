import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { COUNTRIES, type Business } from "@hablahora/contracts";
import { Button, Field, Input, Select } from "@hablahora/ui";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { PageHeader } from "../components/AppShell.js";
import { Card, Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { businessQuery, write } from "../queries.js";
import { useSave } from "./save.js";

const TIME_ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function BusinessPage() {
  const { t } = useI18n();
  const business = useQuery(businessQuery);
  return (
    <>
      <PageHeader title={t.nav.business} subtitle={t.cfg.business.subtitle} />
      <ReadOnlyNote />
      <Loaded query={business}>{(b) => <BusinessForm business={b} />}</Loaded>
    </>
  );
}

function BusinessForm({ business }: { business: Business }) {
  const { t, locale } = useI18n();
  const c = t.cfg.business;
  const canEdit = useCanEdit();
  const schema = z.object({
    name: z.string().trim().min(1, t.cfg.common.required).max(120),
    locationName: z.string().trim().min(1, t.cfg.common.required).max(120),
    address: z.string().trim().max(300),
    timezone: z.string().refine((tz) => TIME_ZONES.length === 0 || TIME_ZONES.includes(tz) || tz === "UTC", c.timezoneInvalid),
    defaultLocale: z.enum(["es", "en"]),
  });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: business.name,
      locationName: business.locationName,
      address: business.address ?? "",
      timezone: business.timezone,
      defaultLocale: business.defaultLocale,
    },
  });
  const save = useSave({
    mutation: (v: z.infer<typeof schema>) => write<Business>("PATCH", "/api/merchant/business", { ...v, address: v.address || null }),
    updates: businessQuery.queryKey,
    invalidates: [["me"]],
    form: form as never,
  });
  const err = form.formState.errors;

  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
      <fieldset disabled={!canEdit} className="flex flex-col gap-6">
        <Card>
          <Field id="name" label={c.name} error={err.name?.message}>
            <Input id="name" aria-invalid={!!err.name} {...form.register("name")} />
          </Field>
          <Field id="locationName" label={c.locationName} hint={c.locationHint} error={err.locationName?.message}>
            <Input id="locationName" aria-invalid={!!err.locationName} {...form.register("locationName")} />
          </Field>
          <Field id="address" label={`${c.address} (${t.cfg.common.optional.toLowerCase()})`}>
            <Input id="address" autoComplete="street-address" {...form.register("address")} />
          </Field>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">{c.countryAndCurrency}</p>
            <p>
              {COUNTRIES[business.country][locale]} · {business.currency}
            </p>
            <p className="text-sm text-muted">{c.countryAndCurrencyHint}</p>
          </div>
          <Field id="timezone" label={c.timezone} hint={c.timezoneHint} error={err.timezone?.message}>
            <Input id="timezone" list="timezones" aria-invalid={!!err.timezone} {...form.register("timezone")} />
          </Field>
          <datalist id="timezones">
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <Field id="defaultLocale" label={c.locale} hint={c.localeHint}>
            <Select id="defaultLocale" {...form.register("defaultLocale")}>
              <option value="es">Español</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </Card>
        {canEdit ? (
          <div>
            <Button type="submit" variant="brand" disabled={save.isPending}>
              {t.cfg.common.save}
            </Button>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}
