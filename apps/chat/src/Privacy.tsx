import type { PrivacyNotice } from "@hablahora/contracts";
import { BrandWordmark } from "@hablahora/ui";
import { useEffect, useState } from "react";
import { detectLocale, MESSAGES, type Locale } from "./i18n.js";

/** Aviso de privacidad del chat (/privacidad): el texto lo publica la plataforma. */
export function PrivacyPage() {
  const requested = new URLSearchParams(window.location.search).get("lang");
  const locale: Locale = requested === "en" || requested === "es" ? requested : detectLocale(navigator.languages ?? [navigator.language], "es");
  const t = MESSAGES[locale];
  const [notice, setNotice] = useState<PrivacyNotice | null | "error">(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t.privacyTitle;
    fetch("/api/privacy")
      .then((r) => (r.ok ? (r.json() as Promise<PrivacyNotice>) : Promise.reject(new Error(String(r.status)))))
      .then(setNotice, () => setNotice("error"));
  }, [locale, t.privacyTitle]);

  // en el idioma pedido; si no está escrito, en el otro
  const text = notice && notice !== "error" ? (locale === "en" ? (notice.en ?? notice.es) : (notice.es ?? notice.en)) : null;
  const updated =
    notice && notice !== "error" && notice.updatedAt
      ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es", { day: "numeric", month: "long", year: "numeric" }).format(new Date(notice.updatedAt))
      : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 bg-bg px-6 py-10 text-ink">
      <BrandWordmark className="text-xl text-ink" />
      <h1 className="text-3xl font-display font-bold text-balance">{t.privacyTitle}</h1>
      {notice === null ? (
        <p className="text-muted" role="status">
          …
        </p>
      ) : notice === "error" ? (
        <p className="text-danger">{t.loadError}</p>
      ) : text ? (
        <>
          <div className="leading-relaxed whitespace-pre-wrap">{text}</div>
          {updated ? <p className="text-sm text-muted">{t.privacyUpdated(updated)}</p> : null}
        </>
      ) : (
        <p className="text-muted">{t.privacyMissing}</p>
      )}
    </main>
  );
}
