import { Button, cn } from "@hablahora/ui";
import { SquarePen, X } from "lucide-react";
import { initials, type Locale, type Messages } from "../i18n.js";

export function Header(props: {
  name: string;
  /** logo del negocio; sin logo, sus iniciales con su color */
  logoUrl?: string | null;
  locale: Locale;
  t: Messages;
  onLocale: (l: Locale) => void;
  onNewChat: () => void;
  canStartNew: boolean;
  /** incrustado: cerrar el panel */
  onClose?: () => void;
}) {
  const { name, locale, t } = props;
  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      {props.logoUrl ? (
        <img src={props.logoUrl} alt="" className="h-10 w-10 flex-none rounded-full bg-surface object-cover ring-1 ring-line" />
      ) : (
        <div
          aria-hidden="true"
          className="grid h-10 w-10 flex-none place-items-center rounded-full bg-accent text-[0.95rem] font-semibold text-white"
        >
          {initials(name)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base leading-tight font-semibold">{name}</h1>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-success" />
          {t.online}
        </p>
      </div>
      <div role="group" aria-label={t.language} className="flex rounded-full border border-line p-0.5 text-xs">
        {(["es", "en"] as const).map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            aria-pressed={locale === l}
            onClick={() => props.onLocale(l)}
            className={cn(
              "rounded-full px-2.5 py-1 font-semibold uppercase focus-visible:outline-2 focus-visible:outline-accent",
              locale === l ? "bg-ink text-bg" : "text-muted hover:text-ink",
            )}
          >
            {l}
          </button>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={props.onNewChat}
        disabled={!props.canStartNew}
        aria-label={t.newChat}
        title={t.newChat}
      >
        <SquarePen className="h-5 w-5" aria-hidden="true" />
      </Button>
      {props.onClose ? (
        <Button variant="ghost" size="icon" onClick={props.onClose} aria-label={t.close} title={t.close}>
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      ) : null}
    </header>
  );
}
