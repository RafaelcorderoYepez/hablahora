import { useQuery } from "@tanstack/react-query";
import type { AgentTone, Business } from "@hablahora/contracts";
import { Button, cn, Field, Textarea } from "@hablahora/ui";
import { useState } from "react";
import { PageHeader } from "../components/AppShell.js";
import { Card, LangTabs, Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { businessQuery, write } from "../queries.js";
import { useSave } from "./save.js";

const TONES: AgentTone[] = ["warm", "professional", "brief"];

export function AgentPage() {
  const { t } = useI18n();
  const business = useQuery(businessQuery);
  return (
    <>
      <PageHeader title={t.nav.agent} subtitle={t.cfg.agent.subtitle} />
      <ReadOnlyNote />
      <Loaded query={business}>{(b) => <AgentForm business={b} />}</Loaded>
    </>
  );
}

type AgentFields = Pick<Business, "agentTone" | "agentInstructions" | "agentInstructionsEn" | "agentHandoff" | "agentHandoffEn">;

function AgentForm({ business }: { business: Business }) {
  const { t } = useI18n();
  const a = t.cfg.agent;
  const canEdit = useCanEdit();
  const [v, setV] = useState<AgentFields>({
    agentTone: business.agentTone,
    agentInstructions: business.agentInstructions ?? "",
    agentInstructionsEn: business.agentInstructionsEn ?? "",
    agentHandoff: business.agentHandoff ?? "",
    agentHandoffEn: business.agentHandoffEn ?? "",
  });
  const save = useSave({
    mutation: (x: AgentFields) => write<Business>("PATCH", "/api/merchant/business", x),
    updates: businessQuery.queryKey,
  });
  const text = (key: keyof AgentFields) => ({
    value: (v[key] as string | null) ?? "",
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setV({ ...v, [key]: e.target.value }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(v);
      }}
    >
      <fieldset disabled={!canEdit} className="flex flex-col gap-6">
        <Card title={a.tone}>
          <div role="radiogroup" aria-label={a.tone} className="grid gap-3 md:grid-cols-3">
            {TONES.map((tone) => {
              const checked = v.agentTone === tone;
              return (
                <label
                  key={tone}
                  className={cn(
                    "flex cursor-pointer flex-col gap-2 rounded-xl border p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    checked ? "border-ink bg-raised" : "border-line",
                  )}
                >
                  <span className="flex items-center gap-2 font-semibold">
                    <input
                      type="radio"
                      name="agentTone"
                      value={tone}
                      checked={checked}
                      onChange={() => setV({ ...v, agentTone: tone })}
                      aria-labelledby={`tone-${tone}-label`}
                      aria-describedby={`tone-${tone}-example`}
                      className="accent-[var(--ui-accent)]"
                    />
                    <span id={`tone-${tone}-label`}>{a.tones[tone].label}</span>
                  </span>
                  <span id={`tone-${tone}-example`} className="rounded-lg rounded-bl-sm border border-line bg-bg px-3 py-2 text-sm">
                    {a.tones[tone].example}
                  </span>
                </label>
              );
            })}
          </div>
        </Card>
        <Card title={a.knowledge} hint={a.knowledgeHint}>
          <LangTabs
            id="knowledge"
            es={
              <Field id="agentInstructions" label={`${a.knowledge} (${t.cfg.common.spanish})`}>
                <Textarea id="agentInstructions" rows={8} placeholder={a.knowledgePlaceholder} {...text("agentInstructions")} />
              </Field>
            }
            en={
              <Field id="agentInstructionsEn" label={`${a.knowledge} (${t.cfg.common.english})`} hint={a.enHint}>
                <Textarea id="agentInstructionsEn" rows={8} {...text("agentInstructionsEn")} />
              </Field>
            }
          />
        </Card>
        <Card title={a.handoff} hint={a.handoffHint}>
          <LangTabs
            id="handoff"
            es={
              <Field id="agentHandoff" label={`${a.handoff} (${t.cfg.common.spanish})`}>
                <Textarea id="agentHandoff" rows={4} placeholder={a.handoffPlaceholder} {...text("agentHandoff")} />
              </Field>
            }
            en={
              <Field id="agentHandoffEn" label={`${a.handoff} (${t.cfg.common.english})`} hint={a.enHint}>
                <Textarea id="agentHandoffEn" rows={4} {...text("agentHandoffEn")} />
              </Field>
            }
          />
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
