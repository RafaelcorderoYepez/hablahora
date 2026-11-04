import { useQuery } from "@tanstack/react-query";
import type { Policies } from "@hablahora/contracts";
import { Button, Field, Select, SwitchField } from "@hablahora/ui";
import { useState } from "react";
import { PageHeader } from "../components/AppShell.js";
import { Card, Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { useI18n, type Messages } from "../i18n.js";
import { policiesQuery, write } from "../queries.js";
import { useSave } from "./save.js";

const SLOT = [5, 10, 15, 20, 30, 60] as const;
const LEAD = [0, 15, 30, 60, 120, 180, 240, 720, 1440, 2880];
const ADVANCE = [7, 14, 30, 60, 90, 180, 365];
const CUTOFF = [0, 60, 120, 240, 720, 1440, 2880];

/** 90 → "90 minutos"; 120 → "2 horas"; 1440 → "1 día". */
function duration(min: number, p: Messages["cfg"]["policies"]): string {
  if (min === 0) return p.none;
  if (min % 1440 === 0) return p.days(min / 1440);
  if (min % 60 === 0) return p.hours(min / 60);
  return p.minutes(min);
}

/** Las opciones, más el valor actual si alguien lo configuró por fuera de la lista. */
const withCurrent = (list: readonly number[], current: number) => (list.includes(current) ? list : [...list, current].sort((a, b) => a - b));

export function PoliciesPage() {
  const { t } = useI18n();
  const policies = useQuery(policiesQuery);
  return (
    <>
      <PageHeader title={t.nav.policies} subtitle={t.cfg.policies.subtitle} />
      <ReadOnlyNote />
      <Loaded query={policies}>{(p) => <PoliciesForm initial={p} />}</Loaded>
    </>
  );
}

function PoliciesForm({ initial }: { initial: Policies }) {
  const { t } = useI18n();
  const p = t.cfg.policies;
  const canEdit = useCanEdit();
  const [v, setV] = useState<Policies>(initial);
  const save = useSave({ mutation: (x: Policies) => write<Policies>("PUT", "/api/merchant/policies", x), updates: policiesQuery.queryKey });
  const num = (key: keyof Policies) => (e: React.ChangeEvent<HTMLSelectElement>) => setV({ ...v, [key]: Number(e.target.value) });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(v);
      }}
    >
      <fieldset disabled={!canEdit} className="flex flex-col gap-6">
        <Card>
          <Field id="slotIntervalMin" label={p.slotInterval} hint={p.slotIntervalHint}>
            <Select id="slotIntervalMin" value={v.slotIntervalMin} onChange={num("slotIntervalMin")}>
              {SLOT.map((n) => (
                <option key={n} value={n}>
                  {p.every(n)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="minLeadTimeMin" label={p.minLead} hint={p.minLeadHint}>
            <Select id="minLeadTimeMin" value={v.minLeadTimeMin} onChange={num("minLeadTimeMin")}>
              {withCurrent(LEAD, v.minLeadTimeMin).map((n) => (
                <option key={n} value={n}>
                  {duration(n, p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="maxAdvanceDays" label={p.maxAdvance}>
            <Select id="maxAdvanceDays" value={v.maxAdvanceDays} onChange={num("maxAdvanceDays")}>
              {withCurrent(ADVANCE, v.maxAdvanceDays).map((n) => (
                <option key={n} value={n}>
                  {p.days(n)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="cancelCutoffMin" label={p.cancelCutoff} hint={p.cancelCutoffHint}>
            <Select id="cancelCutoffMin" value={v.cancelCutoffMin} onChange={num("cancelCutoffMin")}>
              {withCurrent(CUTOFF, v.cancelCutoffMin).map((n) => (
                <option key={n} value={n}>
                  {duration(n, p)}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
        <Card>
          <SwitchField
            id="autoConfirm"
            label={p.autoConfirm}
            hint={v.autoConfirm ? p.autoConfirmOn : undefined}
            checked={v.autoConfirm}
            disabled={!canEdit}
            onCheckedChange={(autoConfirm) => setV({ ...v, autoConfirm })}
          />
          {!v.autoConfirm ? <p className="rounded-lg bg-warning-bg px-4 py-3 text-sm text-warning">{p.autoConfirmOff}</p> : null}
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
