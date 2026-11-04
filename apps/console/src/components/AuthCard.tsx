import { cn, BrandWordmark } from "@hablahora/ui";
import type { ReactNode } from "react";
import { useI18n } from "../i18n.js";

/** Marco de las pantallas sin sesión: marca, selector de idioma y una tarjeta centrada. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg px-4 py-10 text-ink">
      <div className="flex w-full max-w-sm items-center justify-between">
        <BrandWordmark className="text-2xl text-ink" />
        <div role="group" aria-label={t.menu.language} className="flex rounded-full border border-line p-0.5 text-xs">
          {(["es", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-pressed={locale === l}
              onClick={() => setLocale(l)}
              className={cn(
                "rounded-full px-2.5 py-1 font-semibold uppercase focus-visible:outline-2 focus-visible:outline-accent",
                locale === l ? "bg-ink text-bg" : "text-muted hover:text-ink",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <section className="mt-10 flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-line bg-raised p-6 shadow-sm">
        <h1 className="text-2xl font-display font-bold text-balance">{title}</h1>
        {children}
      </section>
    </main>
  );
}

export function FormMessage({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg px-3 py-2 text-sm", tone === "error" ? "bg-danger-bg text-danger" : "bg-success-bg text-success")}
    >
      {children}
    </p>
  );
}
