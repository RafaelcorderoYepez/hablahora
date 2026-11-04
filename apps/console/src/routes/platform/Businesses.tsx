import { useQuery } from "@tanstack/react-query";
import { BUSINESS_TEMPLATES, COUNTRIES, COUNTRY_CODES, type CountryCode, type PlatformBusiness, type PlatformBusinessCreate } from "@hablahora/contracts";
import { Badge, Button, ConfirmDialog, Field, Input, Select, Sheet } from "@hablahora/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../../components/AppShell.js";
import { Loaded } from "../../components/common.js";
import { formatDate, useI18n } from "../../i18n.js";
import { platformBusinessesQuery, platformPlansQuery, platformSettingsQuery, write } from "../../queries.js";
import { usePlatformSave } from "./common.js";

const TIME_ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
const STATUS_TONE = { active: "success", suspended: "warning", closed: "neutral" } as const;
/** tenants.vertical → plantilla (para mostrar el rubro) */
const VERTICAL_TEMPLATE: Record<string, string> = { salon: "salon", barbershop: "barberia", clinic: "clinica", aesthetics: "estetica" };

/** Negocios de la plataforma: estado, plan, uso del mes; alta y detalle. */
export function PlatformBusinessesPage() {
  const { t, locale } = useI18n();
  const p = t.platform;
  const list = useQuery(platformBusinessesQuery);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.data?.find((b) => b.id === openId) ?? null;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={p.nav.businesses} subtitle={p.businessesSubtitle} />
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {p.newBusiness}
        </Button>
      </div>
      <Loaded query={list}>
        {(items) =>
          items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-8 text-muted">{p.noBusinesses}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {items.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(b.id)}
                    className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="min-w-0 flex-1 truncate font-semibold">{b.name}</span>
                      <Badge tone={STATUS_TONE[b.status]}>{p.status[b.status]}</Badge>
                      <Badge>{b.plan.name}</Badge>
                    </span>
                    <span className="flex flex-wrap gap-x-3 text-sm text-muted">
                      <span>{b.owner?.email ?? p.noOwner}</span>
                      <span className="tabular-nums">{p.conversations(b.usage.conversationsThisMonth, b.usage.maxConversationsPerMonth)}</span>
                      <span className="tabular-nums">{p.staff(b.usage.activeStaff, b.usage.maxActiveStaff)}</span>
                      {!b.chatEnabled ? <span>{p.chatOff}</span> : null}
                      <span>
                        {p.since} {formatDate(b.createdAt, locale)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <Sheet open={creating} onOpenChange={setCreating} title={p.createTitle}>
        {creating ? <CreateBusinessForm onDone={() => setCreating(false)} /> : null}
      </Sheet>
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)} title={p.detailTitle}>
        {open ? <BusinessDetail key={open.id} business={open} /> : null}
      </Sheet>
    </>
  );
}

function CreateBusinessForm({ onDone }: { onDone: () => void }) {
  const { t, locale } = useI18n();
  const p = t.platform;
  const plans = useQuery(platformPlansQuery).data ?? [];
  const [form, setForm] = useState({
    name: "",
    country: "CL" as CountryCode,
    template: "salon" as PlatformBusinessCreate["template"],
    ownerName: "",
    ownerEmail: "",
    timezone: COUNTRIES.CL.timezone as string,
    locale: COUNTRIES.CL.locale as "es" | "en",
    planId: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const create = usePlatformSave(
    (body: PlatformBusinessCreate) => write<PlatformBusiness>("POST", "/api/platform/businesses", body),
    (b) => p.created(b.owner?.email ?? form.ownerEmail),
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = t.cfg.common.required;
    if (!form.ownerName.trim()) next.ownerName = t.cfg.common.required;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.ownerEmail.trim())) next.ownerEmail = t.login.emailInvalid;
    if (TIME_ZONES.length && !TIME_ZONES.includes(form.timezone)) next.timezone = t.cfg.business.timezoneInvalid;
    setErrors(next);
    if (Object.keys(next).length) return;
    create.mutate(
      {
        name: form.name.trim(),
        country: form.country,
        template: form.template,
        owner: { name: form.ownerName.trim(), email: form.ownerEmail.trim() },
        timezone: form.timezone,
        locale: form.locale,
        ...(form.planId ? { planId: form.planId } : {}),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <Field id="pb-name" label={p.name} error={errors.name}>
        <Input id="pb-name" value={form.name} aria-invalid={!!errors.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field id="pb-country" label={p.country} hint={p.countryHint}>
        <Select
          id="pb-country"
          value={form.country}
          onChange={(e) => {
            // la zona y el idioma siguen al país (se pueden cambiar abajo)
            const country = e.target.value as CountryCode;
            set({ country, timezone: COUNTRIES[country].timezone, locale: COUNTRIES[country].locale });
          }}
        >
          {COUNTRY_CODES.map((c) => (
            <option key={c} value={c}>
              {COUNTRIES[c][locale]} · {COUNTRIES[c].currency}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="pb-template" label={p.template} hint={p.templateHint}>
        <Select id="pb-template" value={form.template} onChange={(e) => set({ template: e.target.value as typeof form.template })}>
          {BUSINESS_TEMPLATES.map((k) => (
            <option key={k} value={k}>
              {p.templates[k]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pb-owner-name" label={p.ownerName} error={errors.ownerName}>
          <Input id="pb-owner-name" value={form.ownerName} aria-invalid={!!errors.ownerName} onChange={(e) => set({ ownerName: e.target.value })} />
        </Field>
        <Field id="pb-owner-email" label={p.ownerEmail} hint={p.ownerHint} error={errors.ownerEmail}>
          <Input
            id="pb-owner-email"
            type="email"
            value={form.ownerEmail}
            aria-invalid={!!errors.ownerEmail}
            onChange={(e) => set({ ownerEmail: e.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pb-timezone" label={p.timezone} error={errors.timezone}>
          <Input id="pb-timezone" list="pb-timezones" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} />
        </Field>
        <datalist id="pb-timezones">
          {TIME_ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <Field id="pb-locale" label={p.locale}>
          <Select id="pb-locale" value={form.locale} onChange={(e) => set({ locale: e.target.value as "es" | "en" })}>
            <option value="es">{t.cfg.common.spanish}</option>
            <option value="en">{t.cfg.common.english}</option>
          </Select>
        </Field>
      </div>
      <Field id="pb-plan" label={p.plan}>
        <Select id="pb-plan" value={form.planId} onChange={(e) => set({ planId: e.target.value })}>
          {plans.map((pl) => (
            <option key={pl.id} value={pl.isDefault ? "" : pl.id}>
              {pl.name}
              {pl.isDefault ? ` · ${p.defaultBadge}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="brand" className="self-start" disabled={create.isPending}>
        {p.create}
      </Button>
    </form>
  );
}

function BusinessDetail({ business: b }: { business: PlatformBusiness }) {
  const { t, locale } = useI18n();
  const p = t.platform;
  const plans = useQuery(platformPlansQuery).data ?? [];
  const settings = useQuery(platformSettingsQuery).data;
  const [confirm, setConfirm] = useState<"suspended" | "closed" | null>(null);
  const patch = usePlatformSave(
    (body: { planId?: string; agentModel?: string | null; status?: PlatformBusiness["status"] }) =>
      write<PlatformBusiness>("PATCH", `/api/platform/businesses/${b.id}`, body),
    (r) => (r.status !== b.status ? { active: p.reactivated, suspended: p.suspended, closed: p.closed }[r.status] : p.saved),
  );
  const platformModel = settings ? (settings.defaultModel ?? settings.serverModel) : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <p className="text-2xl font-display font-bold">{b.name}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[b.status]}>{p.status[b.status]}</Badge>
          <span className="text-sm text-muted">{p.templates[VERTICAL_TEMPLATE[b.vertical] ?? ""] ?? b.vertical}</span>
        </div>
      </div>
      <dl className="flex flex-col divide-y divide-line">
        <Row label={p.countryAndCurrency}>
          {COUNTRIES[b.country][locale]} · {b.currency}
        </Row>
        <Row label={p.owner}>{b.owner ? `${b.owner.name} · ${b.owner.email}` : p.noOwner}</Row>
        <Row label={p.chatLink}>{b.slug ? `/${b.slug}${b.chatEnabled ? "" : ` · ${p.chatOff}`}` : "—"}</Row>
        <Row label={p.since}>{formatDate(b.createdAt, locale)}</Row>
        <Row label={p.usage}>
          <span className="block tabular-nums">{p.conversations(b.usage.conversationsThisMonth, b.usage.maxConversationsPerMonth)}</span>
          <span className="block tabular-nums">{p.staff(b.usage.activeStaff, b.usage.maxActiveStaff)}</span>
        </Row>
      </dl>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pd-plan" label={p.plan}>
          <Select id="pd-plan" value={b.plan.id} disabled={patch.isPending} onChange={(e) => patch.mutate({ planId: e.target.value })}>
            {plans.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="pd-model" label={p.model}>
          <Select
            id="pd-model"
            value={b.agentModel ?? ""}
            disabled={patch.isPending}
            onChange={(e) => patch.mutate({ agentModel: e.target.value || null })}
          >
            <option value="">{p.modelDefault(platformModel)}</option>
            {(settings?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {b.status === "active" ? (
          <Button variant="outline" disabled={patch.isPending} onClick={() => setConfirm("suspended")}>
            {p.suspend}
          </Button>
        ) : (
          <Button variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ status: "active" })}>
            {p.reactivate}
          </Button>
        )}
        {b.status !== "closed" ? (
          <Button variant="ghost" className="text-danger" disabled={patch.isPending} onClick={() => setConfirm("closed")}>
            {p.close}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "closed" ? p.closeTitle(b.name) : p.suspendTitle(b.name)}
        description={confirm === "closed" ? p.closeBody : p.suspendBody}
        confirmLabel={confirm === "closed" ? p.close : p.suspend}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          if (confirm) patch.mutate({ status: confirm });
          setConfirm(null);
        }}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
