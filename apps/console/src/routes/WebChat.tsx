import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Business, ChatSettings } from "@hablahora/contracts";
import { accentForDark, CHAT_PALETTES, contrastRatio, MIN_ACCENT_CONTRAST, resolveAccent } from "@hablahora/contracts/browser";
import { Button, buttonVariants, cn, Field, Input, SwitchField, Textarea } from "@hablahora/ui";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorText, upload } from "../api.js";
import { PageHeader } from "../components/AppShell.js";
import { Card, LangTabs, Loaded, ReadOnlyNote, useCanEdit } from "../components/common.js";
import { useI18n } from "../i18n.js";
import { businessQuery, readinessQuery, webChatQuery, write } from "../queries.js";
import { useSave } from "./save.js";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function WebChatPage() {
  const { t } = useI18n();
  const business = useQuery(businessQuery);
  return (
    <>
      <PageHeader title={t.nav.webChat} subtitle={t.cfg.webChat.subtitle} />
      <ReadOnlyNote />
      <Loaded query={business}>
        {(b) => (
          <div className="flex flex-col gap-6">
            <ChatToggle business={b} />
            <LinkAndEmbed business={b} />
            <LogoCard business={b} />
            <StyleForm key={JSON.stringify(b.chatSettings)} business={b} />
          </div>
        )}
      </Loaded>
    </>
  );
}

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_BYTES = 256 * 1024;

/** Logo del negocio en su chat: subir, cambiar o quitar. */
function LogoCard({ business }: { business: Business }) {
  const { t } = useI18n();
  const w = t.cfg.webChat;
  const canEdit = useCanEdit();
  const queryClient = useQueryClient();
  const info = useQuery(webChatQuery);
  const logoUrl = info.data?.logoUrl ?? null;
  const done = async (text: string) => {
    await queryClient.invalidateQueries({ queryKey: webChatQuery.queryKey });
    toast.success(text);
  };
  const fail = (err: unknown) => toast.error(errorText(err, t.cfg.errors, t.common.genericError));
  const save = useMutation({ mutationFn: (file: File) => upload<{ logoUrl: string | null }>("/api/merchant/web-chat/logo", file), onSuccess: () => done(w.logoSaved), onError: fail });
  const remove = useMutation({ mutationFn: () => write<void>("DELETE", "/api/merchant/web-chat/logo"), onSuccess: () => done(w.logoRemoved), onError: fail });

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite volver a elegir el mismo archivo
    if (!file) return;
    // se revisa antes de subir; la API vuelve a revisar el contenido real
    if (!LOGO_TYPES.includes(file.type)) return toast.error(t.cfg.errors.logo_invalid);
    if (file.size > MAX_LOGO_BYTES) return toast.error(t.cfg.errors.logo_too_large);
    save.mutate(file);
  };

  return (
    <Card title={w.logo} hint={w.logoHint}>
      <div className="flex flex-wrap items-center gap-4">
        {logoUrl ? (
          <img src={logoUrl} alt={w.logoAlt} className="h-16 w-16 rounded-full bg-surface object-cover ring-1 ring-line" />
        ) : (
          <span aria-hidden="true" className="grid h-16 w-16 place-items-center rounded-full bg-accent text-xl font-semibold text-white">
            {business.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <label className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer", save.isPending && "pointer-events-none opacity-50")}>
              <input type="file" accept={LOGO_TYPES.join(",")} className="sr-only" onChange={pick} disabled={save.isPending} />
              {logoUrl ? w.logoChange : w.logoUpload}
            </label>
            {logoUrl ? (
              <Button variant="ghost" className="text-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {w.logoRemove}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Interruptor "Chat activo" y lo que falta para poder encenderlo. */
function ChatToggle({ business }: { business: Business }) {
  const { t } = useI18n();
  const w = t.cfg.webChat;
  const canEdit = useCanEdit();
  const readiness = useQuery(readinessQuery);
  const missing = readiness.data?.checks.filter((c) => c.required && !c.ok) ?? [];
  const save = useSave({
    mutation: (chatEnabled: boolean) => write<Business>("PATCH", "/api/merchant/business", { chatEnabled }),
    updates: businessQuery.queryKey,
    invalidates: [webChatQuery.queryKey],
    successText: (b: Business) => (b.chatEnabled ? w.enabled : w.disabled),
  });
  return (
    <Card>
      <SwitchField
        id="chat-enabled"
        label={w.active}
        hint={business.chatEnabled ? w.activeOn : w.activeOff}
        checked={business.chatEnabled}
        disabled={!canEdit || save.isPending || (!business.chatEnabled && missing.length > 0)}
        onCheckedChange={(on) => save.mutate(on)}
      />
      {!business.chatEnabled && missing.length ? (
        <div className="rounded-lg bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="font-semibold">{w.missing}</p>
          <ul className="list-disc pl-5">
            {missing.map((m) => (
              <li key={m.key}>{t.home.checks[m.key]}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard?.writeText(text);
        setDone(true);
        toast.success(t.cfg.common.copied);
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {label}
    </Button>
  );
}

/** Enlace público (y su dirección editable) y el código para incrustar. */
function LinkAndEmbed({ business }: { business: Business }) {
  const { t } = useI18n();
  const w = t.cfg.webChat;
  const canEdit = useCanEdit();
  const info = useQuery(webChatQuery);
  const [slug, setSlug] = useState(business.webChatSlug ?? "");
  const [slugError, setSlugError] = useState<string | null>(null);
  const save = useSave({
    mutation: (webChatSlug: string) => write<Business>("PATCH", "/api/merchant/business", { webChatSlug }),
    updates: businessQuery.queryKey,
    invalidates: [webChatQuery.queryKey],
  });
  const snippet = info.data?.embedScriptUrl && info.data.slug
    ? `<script src="${info.data.embedScriptUrl}" data-slug="${info.data.slug}" async></script>`
    : null;

  return (
    <>
      <Card title={w.link} hint={w.linkHint}>
        {info.data?.publicUrl ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 basis-60 truncate rounded-lg border border-line bg-bg px-3 py-2 text-sm">{info.data.publicUrl}</code>
            <CopyButton text={info.data.publicUrl} label={t.cfg.common.copy} />
            <a
              href={info.data.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-brand-text hover:bg-bg"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              {t.cfg.common.open}
            </a>
          </div>
        ) : null}
        {canEdit ? (
          <form
            noValidate
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!SLUG.test(slug)) return setSlugError(w.slugInvalid);
              setSlugError(null);
              save.mutate(slug, {
                onError: (err) => setSlugError(errorText(err, t.cfg.errors, t.common.genericError)),
              });
            }}
          >
            <Field id="chat-slug" label={w.slug} hint={w.slugHint} error={slugError ?? undefined} className="min-w-0 flex-1 basis-60">
              <Input id="chat-slug" value={slug} aria-invalid={!!slugError} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
            </Field>
            <Button type="submit" variant="outline" disabled={save.isPending || slug === business.webChatSlug}>
              {t.cfg.common.save}
            </Button>
          </form>
        ) : null}
      </Card>
      {snippet ? (
        <Card title={w.embed} hint={w.embedHint}>
          <div className="flex flex-col gap-2">
            <pre className="overflow-x-auto rounded-lg border border-line bg-bg px-3 py-2 text-sm">
              <code>{snippet}</code>
            </pre>
            <div>
              <CopyButton text={snippet} label={t.cfg.common.copy} />
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** Estilo del chat: color (paleta o propio), apariencia, bienvenida; con vista previa. */
function StyleForm({ business }: { business: Business }) {
  const { t, locale } = useI18n();
  const w = t.cfg.webChat;
  const canEdit = useCanEdit();
  const [s, setS] = useState<ChatSettings>(business.chatSettings);
  const [customText, setCustomText] = useState(business.chatSettings.accent ?? "#");
  const customValid = /^#[0-9a-fA-F]{6}$/.test(customText);
  const customOk = customValid && contrastRatio("#FFFFFF", customText) >= MIN_ACCENT_CONTRAST;
  const accent = resolveAccent(s.palette === "custom" ? { palette: "custom", accent: customOk ? customText : null } : s);
  const save = useSave({
    mutation: (chatSettings: ChatSettings) => write<Business>("PATCH", "/api/merchant/business", { chatSettings }),
    updates: businessQuery.queryKey,
  });
  const canSave = s.palette !== "custom" || customOk;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        save.mutate({
          ...s,
          accent: s.palette === "custom" ? customText : null,
          welcome: { es: s.welcome.es?.trim() || null, en: s.welcome.en?.trim() || null },
        });
      }}
    >
      <fieldset disabled={!canEdit}>
        <Card title={w.style}>
          <div className="grid gap-8 lg:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-5">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold">{w.color}</legend>
                <div role="radiogroup" aria-label={w.color} className="flex flex-wrap gap-2">
                  {[...CHAT_PALETTES.map((p) => ({ id: p.id, label: p[locale], accent: p.accent })), { id: "custom" as const, label: w.custom, accent: null }].map(
                    (p) => (
                      <label
                        key={p.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                          s.palette === p.id ? "border-ink font-semibold" : "border-line",
                        )}
                      >
                        <input
                          type="radio"
                          name="palette"
                          className="sr-only"
                          checked={s.palette === p.id}
                          onChange={() => setS({ ...s, palette: p.id })}
                        />
                        <i
                          aria-hidden="true"
                          className="h-4 w-4 rounded-full border border-line"
                          style={{ background: p.accent ?? (customOk ? customText : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)") }}
                        />
                        {p.label}
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
              {s.palette === "custom" ? (
                <Field
                  id="chat-custom"
                  label={w.custom}
                  hint={w.customHint}
                  error={customValid && !customOk ? w.contrastBad : undefined}
                  className="sm:w-64"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={w.custom}
                      value={customValid ? customText : "#0b6b6b"}
                      onChange={(e) => setCustomText(e.target.value)}
                      className="h-10 w-12 flex-none cursor-pointer rounded border border-line bg-raised"
                    />
                    <Input id="chat-custom" value={customText} onChange={(e) => setCustomText(e.target.value.trim())} aria-invalid={customValid && !customOk} />
                  </div>
                </Field>
              ) : null}
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold">{w.appearance}</legend>
                {(["auto", "light", "dark"] as const).map((a) => (
                  <label key={a} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="appearance" checked={s.appearance === a} onChange={() => setS({ ...s, appearance: a })} className="accent-[var(--ui-accent)]" />
                    {w.appearances[a]}
                  </label>
                ))}
              </fieldset>
              <LangTabs
                id="welcome"
                es={
                  <Field id="welcome-es" label={`${w.welcome} (${t.cfg.common.spanish})`} hint={w.welcomeHint}>
                    <Textarea id="welcome-es" rows={2} maxLength={300} value={s.welcome.es ?? ""} onChange={(e) => setS({ ...s, welcome: { ...s.welcome, es: e.target.value } })} />
                  </Field>
                }
                en={
                  <Field id="welcome-en" label={`${w.welcome} (${t.cfg.common.english})`} hint={w.welcomeHint}>
                    <Textarea id="welcome-en" rows={2} maxLength={300} value={s.welcome.en ?? ""} onChange={(e) => setS({ ...s, welcome: { ...s.welcome, en: e.target.value } })} />
                  </Field>
                }
              />
            </div>
            <Preview accent={accent} appearance={s.appearance} welcome={s.welcome[locale]?.trim() || null} name={business.name} />
          </div>
          {canEdit ? (
            <div>
              <Button type="submit" variant="brand" disabled={save.isPending || !canSave}>
                {t.cfg.common.save}
              </Button>
            </div>
          ) : null}
        </Card>
      </fieldset>
    </form>
  );
}

/** Vista previa del chat con el color y la apariencia elegidos (en "automático", claro y oscuro). */
function Preview(props: { accent: string; appearance: ChatSettings["appearance"]; welcome: string | null; name: string }) {
  const { t } = useI18n();
  const w = t.cfg.webChat;
  const modes = props.appearance === "auto" ? (["light", "dark"] as const) : ([props.appearance] as const);
  return (
    <div className="flex flex-col gap-2" aria-label={w.preview}>
      <p className="text-sm font-semibold">{w.preview}</p>
      <div className="flex flex-wrap gap-3">
        {modes.map((mode) => (
          // .light / .dark fijan el modo de la vista previa con las mismas variables que el chat
          <div
            key={mode}
            className={cn(mode, "flex w-56 flex-col gap-2 rounded-2xl border border-line bg-bg p-3 text-[0.8rem] text-ink")}
            style={{ "--ui-accent-light": props.accent, "--ui-accent-dark": accentForDark(props.accent) } as React.CSSProperties}
          >
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[0.7rem] font-semibold text-white">
                {props.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate font-semibold">{props.name}</span>
            </div>
            <p className="max-w-[85%] self-start rounded-xl rounded-bl-sm border border-line bg-raised px-2.5 py-1.5">
              {props.welcome ?? w.previewAgent}
            </p>
            <p className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-accent px-2.5 py-1.5 text-white">{w.previewCustomer}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
