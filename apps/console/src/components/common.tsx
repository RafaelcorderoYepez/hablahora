import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Button, cn } from "@hablahora/ui";
import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n.js";
import { meQuery } from "../queries.js";

/** ¿Puede editar la configuración? (merchant_admin, y el negocio no está suspendido) */
export function useCanEdit(): boolean {
  const business = useQuery(meQuery).data?.business;
  return business?.role === "merchant_admin" && business.status === "active";
}

/** Cargando / error con reintento / contenido. */
export function Loaded<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  const { t } = useI18n();
  if (query.isPending) return <p className="text-muted">{t.common.loading}</p>;
  if (query.isError) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-danger">{t.common.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }
  return <>{children(query.data as T)}</>;
}

/** Aviso para el staff: ve la configuración pero no la cambia. */
export function ReadOnlyNote() {
  const { t } = useI18n();
  const business = useQuery(meQuery).data?.business;
  // un administrador con el negocio suspendido ya ve el aviso de la consola
  if (business?.role === "merchant_admin") return null;
  return <p className="mb-6 rounded-lg bg-info-bg px-4 py-3 text-sm text-info">{t.staffNote}</p>;
}

/** Bloque de un formulario: título, ayuda y campos. */
export function Card({ title, hint, children, className }: { title?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 sm:p-6", className)}>
      {title ? (
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          {hint ? <p className="text-sm text-muted">{hint}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Pestañas Español / Inglés para un texto que el negocio escribe en los dos idiomas. */
export function LangTabs({ id, es, en }: { id: string; es: ReactNode; en: ReactNode }) {
  const { t } = useI18n();
  return (
    <LangTabsInner id={id} labels={[t.cfg.common.spanish, t.cfg.common.english]} panels={[es, en]} />
  );
}

function LangTabsInner({ id, labels, panels }: { id: string; labels: [string, string]; panels: [ReactNode, ReactNode] }) {
  const [tab, setTab] = useState(0);
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={labels.join(" / ")} className="flex gap-1 border-b border-line">
        {labels.map((label, i) => (
          <button
            key={label}
            id={`${id}-tab-${i}`}
            type="button"
            role="tab"
            aria-selected={tab === i}
            aria-controls={`${id}-panel-${i}`}
            onClick={() => setTab(i)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-sm font-semibold",
              tab === i ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {panels.map((panel, i) => (
        // los dos paneles quedan montados: sus campos siguen en el formulario aunque no se vean
        <div key={i} id={`${id}-panel-${i}`} role="tabpanel" aria-labelledby={`${id}-tab-${i}`} hidden={tab !== i}>
          {panel}
        </div>
      ))}
    </div>
  );
}
