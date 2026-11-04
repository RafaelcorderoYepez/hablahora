import { useQuery } from "@tanstack/react-query";
import type { Plan, PlanInput } from "@hablahora/contracts";
import { Badge, Button, ConfirmDialog, Field, Input, Sheet, SwitchField } from "@hablahora/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../../components/AppShell.js";
import { Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { platformPlansQuery, write } from "../../queries.js";
import { parseLimit, usePlatformSave } from "./common.js";

/** Planes y sus límites (sin cobros en la v1). */
export function PlatformPlansPage() {
  const { t } = useI18n();
  const p = t.platform;
  const plans = useQuery(platformPlansQuery);
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const limit = (n: number | null) => (n == null ? p.unlimited : String(n));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={p.nav.plans} subtitle={p.plansSubtitle} />
        <Button variant="brand" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {p.newPlan}
        </Button>
      </div>
      <Loaded query={plans}>
        {(list) => (
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
            {list.map((pl) => (
              <li key={pl.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {pl.name}
                    {pl.isDefault ? <Badge tone="info">{p.defaultBadge}</Badge> : null}
                  </p>
                  <p className="text-sm text-muted">
                    {p.maxConversations}: <span className="tabular-nums">{limit(pl.maxConversationsPerMonth)}</span> · {p.maxStaff}:{" "}
                    <span className="tabular-nums">{limit(pl.maxActiveStaff)}</span>
                  </p>
                </div>
                <span className="text-sm text-muted">{p.inUse(pl.businesses)}</span>
                <Button variant="outline" size="sm" onClick={() => setEditing(pl)}>
                  {t.cfg.common.edit}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Loaded>
      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === "new" ? p.newPlan : p.nav.plans}>
        {editing ? <PlanForm key={editing === "new" ? "new" : editing.id} plan={editing === "new" ? null : editing} onDone={() => setEditing(null)} /> : null}
      </Sheet>
    </>
  );
}

function PlanForm({ plan, onDone }: { plan: Plan | null; onDone: () => void }) {
  const { t } = useI18n();
  const p = t.platform;
  const [name, setName] = useState(plan?.name ?? "");
  const [conversations, setConversations] = useState(plan?.maxConversationsPerMonth?.toString() ?? "");
  const [staff, setStaff] = useState(plan?.maxActiveStaff?.toString() ?? "");
  const [locations, setLocations] = useState(String(plan?.maxLocations ?? 1));
  const [isDefault, setIsDefault] = useState(plan?.isDefault ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = usePlatformSave(
    (body: PlanInput) => (plan ? write<Plan>("PUT", `/api/platform/plans/${plan.id}`, body) : write<Plan>("POST", "/api/platform/plans", body)),
    t.cfg.common.saved,
  );
  const remove = usePlatformSave(() => write<void>("DELETE", `/api/platform/plans/${plan!.id}`), p.planDeleted);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = parseLimit(conversations);
    const s = parseLimit(staff);
    const l = parseLimit(locations);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t.cfg.common.required;
    if (c === undefined) next.conversations = p.invalidNumber;
    if (s === undefined) next.staff = p.invalidNumber;
    if (!l) next.locations = p.invalidNumber;
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate(
      { name: name.trim(), maxConversationsPerMonth: c ?? null, maxActiveStaff: s ?? null, maxLocations: l!, isDefault },
      { onSuccess: onDone },
    );
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <Field id="plan-name" label={p.planName} error={errors.name}>
        <Input id="plan-name" value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="plan-conversations" label={p.maxConversations} hint={p.unlimitedHint} error={errors.conversations}>
        <Input id="plan-conversations" inputMode="numeric" value={conversations} onChange={(e) => setConversations(e.target.value)} />
      </Field>
      <Field id="plan-staff" label={p.maxStaff} hint={p.unlimitedHint} error={errors.staff}>
        <Input id="plan-staff" inputMode="numeric" value={staff} onChange={(e) => setStaff(e.target.value)} />
      </Field>
      <Field id="plan-locations" label={p.maxLocations} hint={p.maxLocationsHint} error={errors.locations}>
        <Input id="plan-locations" inputMode="numeric" value={locations} onChange={(e) => setLocations(e.target.value)} />
      </Field>
      <SwitchField
        id="plan-default"
        label={p.isDefault}
        hint={p.isDefaultHint}
        checked={isDefault}
        onCheckedChange={setIsDefault}
        disabled={plan?.isDefault}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="brand" disabled={save.isPending}>
          {t.cfg.common.save}
        </Button>
        {plan && !plan.isDefault && plan.businesses === 0 ? (
          <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(true)}>
            {p.deletePlan}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`${p.deletePlan}: ${plan?.name ?? ""}`}
        description={p.plansSubtitle}
        confirmLabel={p.deletePlan}
        cancelLabel={t.common.cancel}
        onConfirm={() => remove.mutate(undefined, { onSuccess: onDone })}
      />
    </form>
  );
}
