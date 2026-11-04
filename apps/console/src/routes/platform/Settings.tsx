import { useQuery } from "@tanstack/react-query";
import type { PlatformSettings } from "@hablahora/contracts";
import { Button, Field, Select, Textarea } from "@hablahora/ui";
import { useState } from "react";
import { PageHeader } from "../../components/AppShell.js";
import { Card, Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { platformSettingsQuery, write } from "../../queries.js";
import { usePlatformSave } from "./common.js";

/** Configuración global: modelo por defecto del agente. */
export function PlatformSettingsPage() {
  const { t } = useI18n();
  const p = t.platform;
  const settings = useQuery(platformSettingsQuery);
  const save = usePlatformSave(
    (defaultModel: string | null) => write<PlatformSettings>("PUT", "/api/platform/settings", { defaultModel }),
    t.cfg.common.saved,
  );

  return (
    <>
      <PageHeader title={p.nav.settings} subtitle={p.settingsSubtitle} />
      <Loaded query={settings}>
        {(s) => (
          <div className="flex flex-col gap-6">
            <Card>
              <Field id="ps-model" label={p.defaultModel} hint={p.defaultModelHint}>
                <Select id="ps-model" value={s.defaultModel ?? ""} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value || null)}>
                  <option value="">{p.serverModel(s.serverModel)}</option>
                  {s.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            </Card>
            <PrivacyCard key={`${s.privacyEs}|${s.privacyEn}`} settings={s} />
          </div>
        )}
      </Loaded>
    </>
  );
}

/** Texto del aviso de privacidad del chat público, en los dos idiomas. */
function PrivacyCard({ settings }: { settings: PlatformSettings }) {
  const { t } = useI18n();
  const p = t.platform;
  const [es, setEs] = useState(settings.privacyEs ?? "");
  const [en, setEn] = useState(settings.privacyEn ?? "");
  const save = usePlatformSave(
    () => write<PlatformSettings>("PUT", "/api/platform/settings", { defaultModel: settings.defaultModel, privacyEs: es, privacyEn: en }),
    p.privacySaved,
  );
  return (
    <Card title={p.privacyTitle} hint={p.privacyHint}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field id="privacy-es" label={p.privacyEs}>
          <Textarea id="privacy-es" rows={8} maxLength={20_000} value={es} onChange={(e) => setEs(e.target.value)} />
        </Field>
        <Field id="privacy-en" label={p.privacyEn}>
          <Textarea id="privacy-en" rows={8} maxLength={20_000} value={en} onChange={(e) => setEn(e.target.value)} />
        </Field>
        <Button type="submit" variant="brand" className="self-start" disabled={save.isPending}>
          {t.cfg.common.save}
        </Button>
      </form>
    </Card>
  );
}
